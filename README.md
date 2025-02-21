# Postgres S3 backups

A simple NodeJS application to backup your PostgreSQL database to S3 via a cron, with support for parallel backups and recovery.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template/I4zGrH)

## Configuration

- `AWS_ACCESS_KEY_ID` - AWS access key ID.

- `AWS_SECRET_ACCESS_KEY` - AWS secret access key, sometimes also called an application key.

- `AWS_S3_BUCKET` - The name of the bucket that the access key ID and secret access key are authorized to access.

- `AWS_S3_REGION` - The name of the region your bucket is located in, set to `auto` if unknown.

- `BACKUP_DATABASE_URL` - The connection string of the database to backup.

- `AWS_S3_ENDPOINT` - The S3 custom endpoint you want to use. Applicable for 3-rd party S3 services such as Cloudflare R2 or Backblaze R2.

- `AWS_S3_FORCE_PATH_STYLE` - Use path style for the endpoint instead of the default subdomain style, useful for MinIO. Default `false`

- `RUN_ON_STARTUP` - Run a backup on startup of this application then proceed with making backups on the set schedule.

- `BACKUP_FILE_PREFIX` - Add a prefix to the file name.

- `BUCKET_SUBFOLDER` - Define a subfolder to place the backup files in.

- `SINGLE_SHOT_MODE` - Run a single backup on start and exit when completed. Useful with the platform's native CRON schedular.

- `SUPPORT_OBJECT_LOCK` - Enables support for buckets with object lock by providing an MD5 hash with the backup file.

- `BACKUP_OPTIONS` - Add any valid pg_dump option, supported pg_dump options can be found [here](https://www.postgresql.org/docs/current/app-pgdump.html). Example: `--exclude-table=pattern`

- `BACKUP_RETENTION_COUNT` - Number of backups to keep for each backup type. Default is 5.

- `PARALLEL_JOBS` - Number of parallel jobs to use for backup and restore operations (requires PostgreSQL 9.3+). Default is 1.

## Backup Types and Retention

The application maintains different types of backups with varying frequencies:

- **10-minute backups**: Keeps the most recent backups taken every 10 minutes
- **Hourly backups**: Keeps the most recent hourly backups
- **Daily backups**: Keeps the most recent daily backups
- **Weekly backups**: Keeps the most recent weekly backups

Each backup type is stored in its own folder in S3 (e.g., `10min/`, `hourly/`, `daily/`, `weekly/`). The `BACKUP_RETENTION_COUNT` setting controls how many backups to keep for each type. For example, if set to 5, it will keep:

- 5 most recent 10-minute backups
- 5 most recent hourly backups
- 5 most recent daily backups
- 5 most recent weekly backups

Older backups are automatically cleaned up after each new backup is created.

## Parallel Backup Support

The application supports parallel backup and restore operations through PostgreSQL's native parallel processing capabilities. This can significantly speed up backup and restore operations for large databases. To enable parallel processing:

1. Set the `PARALLEL_JOBS` environment variable to a number greater than 1
2. Ensure you're using PostgreSQL 9.3 or later
3. Consider your database server's resources when setting the number of parallel jobs

The parallel processing feature is used for both backup creation and restoration operations.

## Backup Recovery

The application includes a CLI tool for listing and restoring backups. To use the recovery features:

### Listing Available Backups

```bash
# List all backups
node cli.js list

# List backups of a specific frequency (10min, hourly, daily, weekly)
node cli.js list hourly
```

### Restoring a Backup

```bash
# Restore a backup to the same database
node cli.js restore <backup-key>

# Restore a backup to a different database
node cli.js restore <backup-key> "postgresql://user:pass@host:5432/different_db"
```

The restore operation will:
1. Download the backup from S3
2. Extract it to a temporary location
3. Restore it to the specified database (or the same database as backup if not specified)
4. Clean up temporary files automatically

The restore process uses the same parallel processing configuration as backups when available.
