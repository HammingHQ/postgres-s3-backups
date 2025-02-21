import { backup, startBackupScheduler } from "./backup.js";
import { env } from "./env.js";

console.log("NodeJS Version: " + process.version);

const tryBackup = async () => {
  try {
    await backup();
  } catch (error) {
    console.error("Error while running backup: ", error);
    process.exit(1);
  }
};

// Handle process termination
process.on('SIGTERM', () => {
  console.log('Received SIGTERM signal. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT signal. Shutting down gracefully...');
  process.exit(0);
});

// Main async function to handle startup and scheduling
const main = async () => {
  try {
    if (env.RUN_ON_STARTUP || env.SINGLE_SHOT_MODE) {
      console.log("Running on start backup...");
      await tryBackup();

      if (env.SINGLE_SHOT_MODE) {
        console.log("Database backup complete, exiting...");
        process.exit(0);
      }
    }

    await startBackupScheduler();
  } catch (error) {
    console.error('Application failed:', error);
    process.exit(1);
  }
};

// Start the application
main().catch(error => {
  console.error('Failed to start application:', error);
  process.exit(1);
});