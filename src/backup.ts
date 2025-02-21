import { exec, execSync } from "child_process";
import { S3Client, S3ClientConfig, PutObjectCommandInput, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream, unlink, statSync } from "fs";
import { filesize } from "filesize";
import path from "path";
import os from "os";

import { env } from "./env.js";
import { createMD5 } from "./util.js";

type BackupFrequency = '10min' | 'hourly' | 'daily' | 'weekly';

interface BackupInterval {
  frequency: BackupFrequency;
  milliseconds: number;
}

const BACKUP_INTERVALS: BackupInterval[] = [
  { frequency: 'weekly', milliseconds: 7 * 24 * 60 * 60 * 1000 },
  { frequency: 'daily', milliseconds: 24 * 60 * 60 * 1000 },
  { frequency: 'hourly', milliseconds: 60 * 60 * 1000 },
  { frequency: '10min', milliseconds: 10 * 60 * 1000 }
];

// Keep track of last backup time for each frequency
const lastBackupTimes = new Map<BackupFrequency, Date>();

const getLastBackupTimes = async (client: S3Client, bucket: string, prefix: string): Promise<Map<BackupFrequency, Date>> => {
  console.log("Getting last backup times from S3...");
  const result = new Map<BackupFrequency, Date>();

  for (const interval of BACKUP_INTERVALS) {
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${prefix}${interval.frequency}/`,
    });

    try {
      const response = await client.send(command);
      if (response.Contents && response.Contents.length > 0) {
        // Sort by last modified date, newest first
        const sortedObjects = response.Contents
          .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));

        // Get the most recent backup's timestamp
        if (sortedObjects[0].LastModified) {
          result.set(interval.frequency, sortedObjects[0].LastModified);
          console.log(`Found last ${interval.frequency} backup from: ${sortedObjects[0].LastModified}`);
        }
      }
    } catch (error) {
      console.error(`Error getting last backup time for ${interval.frequency}:`, error);
    }
  }

  return result;
};

const shouldRunBackup = (frequency: BackupFrequency, now: Date): boolean => {
  const lastBackup = lastBackupTimes.get(frequency);
  if (!lastBackup) {
    return true; // First time running
  }

  const interval = BACKUP_INTERVALS.find(i => i.frequency === frequency)!;
  const timeSinceLastBackup = now.getTime() - lastBackup.getTime();
  
  return timeSinceLastBackup >= interval.milliseconds;
};

const runBackup = async (frequency: BackupFrequency) => {
  console.log(`Initiating ${frequency} backup...`);

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]+/g, '-');
  const filename = `${env.BACKUP_FILE_PREFIX}-${timestamp}.tar.gz`;
  const filepath = path.join(os.tmpdir(), filename);

  try {
    await dumpToFile(filepath);
    await uploadToS3({ name: filename, path: filepath, frequency });
    await deleteFile(filepath);
    lastBackupTimes.set(frequency, now);
    console.log(`DB backup complete (${frequency} backup)...`);
  } catch (error) {
    console.error("Backup failed:", error);
  }
};

export const startBackupScheduler = async () => {
  console.log("Starting backup scheduler...");
  
  // Initialize S3 client
  const clientOptions: S3ClientConfig = {
    region: env.AWS_S3_REGION,
    forcePathStyle: env.AWS_S3_FORCE_PATH_STYLE
  };

  if (env.AWS_S3_ENDPOINT) {
    clientOptions.endpoint = env.AWS_S3_ENDPOINT;
  }

  const client = new S3Client(clientOptions);
  const bucket = env.AWS_S3_BUCKET;
  const prefix = env.BUCKET_SUBFOLDER ? `${env.BUCKET_SUBFOLDER}/` : '';

  // Seed the lastBackupTimes map from S3
  const initialBackupTimes = await getLastBackupTimes(client, bucket, prefix);
  for (const [frequency, date] of initialBackupTimes) {
    lastBackupTimes.set(frequency, date);
  }
  
  while (true) {
    const now = new Date();
    
    // Align to the next minute
    const waitMs = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    await sleep(waitMs);
    
    // Check each backup type
    for (const interval of BACKUP_INTERVALS) {
      if (shouldRunBackup(interval.frequency, new Date())) {
        console.log(`Triggering ${interval.frequency} backup`);
        await runBackup(interval.frequency);
      }
    }
    
    // Wait for 1 minute before next check
    await sleep(60 * 1000);
  }
};

// For backward compatibility, keep the backup function
export const backup = async () => {
  // When running a manual backup, use 10min frequency
  await runBackup('10min');
};

const cleanupOldBackups = async (client: S3Client, bucket: string, prefix: string, frequency: BackupFrequency) => {
  console.log(`Cleaning up old ${frequency} backups...`);
  
  const command = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: `${prefix}${frequency}/`,
  });

  const response = await client.send(command);
  if (!response.Contents) return;

  // Sort by last modified date, newest first
  const sortedObjects = response.Contents
    .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));

  // Keep only the configured number of backups
  const objectsToDelete = sortedObjects.slice(env.BACKUP_RETENTION_COUNT);

  for (const object of objectsToDelete) {
    if (!object.Key) continue;
    
    await client.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: object.Key,
    }));
    console.log(`Deleted old backup: ${object.Key}`);
  }
};

const uploadToS3 = async ({ name, path, frequency }: { name: string, path: string, frequency: BackupFrequency }) => {
  console.log("Uploading backup to S3...");

  const bucket = env.AWS_S3_BUCKET;

  const clientOptions: S3ClientConfig = {
    region: env.AWS_S3_REGION,
    forcePathStyle: env.AWS_S3_FORCE_PATH_STYLE
  }

  if (env.AWS_S3_ENDPOINT) {
    console.log(`Using custom endpoint: ${env.AWS_S3_ENDPOINT}`);
    clientOptions.endpoint = env.AWS_S3_ENDPOINT;
  }

  let prefix = env.BUCKET_SUBFOLDER ? `${env.BUCKET_SUBFOLDER}/` : '';
  const s3Key = `${prefix}${frequency}/${name}`;

  let params: PutObjectCommandInput = {
    Bucket: bucket,
    Key: s3Key,
    Body: createReadStream(path),
  }

  if (env.SUPPORT_OBJECT_LOCK) {
    console.log("MD5 hashing file...");
    const md5Hash = await createMD5(path);
    console.log("Done hashing file");
    params.ContentMD5 = Buffer.from(md5Hash, 'hex').toString('base64');
  }

  const client = new S3Client(clientOptions);

  await new Upload({
    client,
    params: params
  }).done();

  console.log("Backup uploaded to S3");

  // Clean up old backups in this frequency category
  await cleanupOldBackups(client, bucket, prefix, frequency);
}

const dumpToFile = async (filePath: string) => {
  console.log("Dumping DB to file...");

  await new Promise((resolve, reject) => {
    const parallelOption = env.PARALLEL_JOBS > 1 ? ` --jobs=${env.PARALLEL_JOBS}` : '';
    exec(`pg_dump --dbname=${env.BACKUP_DATABASE_URL}${parallelOption} --format=directory ${env.BACKUP_OPTIONS} -f ${filePath}.tmp && tar -czf ${filePath} -C ${filePath}.tmp . && rm -rf ${filePath}.tmp`, (error, stdout, stderr) => {
      if (error) {
        reject({ error: error, stderr: stderr.trimEnd() });
        return;
      }

      // check if archive is valid and contains data
      const isValidArchive = (execSync(`gzip -cd ${filePath} | head -c1`).length == 1) ? true : false;
      if (isValidArchive == false) {
        reject({ error: "Backup archive file is invalid or empty; check for errors above" });
        return;
      }

      // not all text in stderr will be a critical error, print the error / warning
      if (stderr != "") {
        console.log({ stderr: stderr.trimEnd() });
      }

      console.log("Backup archive file is valid");
      console.log("Backup filesize:", filesize(statSync(filePath).size));

      // if stderr contains text, let the user know that it was potently just a warning message
      if (stderr != "") {
        console.log(`Potential warnings detected; Please ensure the backup file "${path.basename(filePath)}" contains all needed data`);
      }

      resolve(undefined);
    });
  });

  console.log("DB dumped to file...");
}

const deleteFile = async (path: string) => {
  console.log("Deleting file...");
  await new Promise((resolve, reject) => {
    unlink(path, (err) => {
      if (err) {
        reject({ error: err });
        return;
      }
      resolve(undefined);
    });
  });
  console.log("File deleted...");
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
