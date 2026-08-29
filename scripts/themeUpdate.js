const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const repositoryUrl = "https://github.com/zeon-studio/hugoplate";
const localDirectory = path.join(__dirname, "../themes/hugoplate");
const foldersToFetch = ["assets", "layouts"];

// Create a temporary directory for the update process
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hugoplate-update-"));

try {
  // Download and extract the repository once to a temporary directory
  // to improve performance and avoid fragile shell piping.
  execSync(`curl -L ${repositoryUrl}/tarball/main | tar -xz -C ${tempDir} --strip-components=1`);

  foldersToFetch.forEach((folder) => {
    const sourceFolder = path.join(tempDir, folder);
    const destinationFolder = path.join(localDirectory, folder);

    if (fs.existsSync(sourceFolder)) {
      console.log(`Updating ${folder}...`);
      if (fs.existsSync(destinationFolder)) {
        fs.rmSync(destinationFolder, { recursive: true, force: true });
      }
      fs.mkdirSync(destinationFolder, { recursive: true });
      // Use fs.cpSync for recursive copy
      fs.cpSync(sourceFolder, destinationFolder, { recursive: true });
    }
  });
  console.log("Update complete.");
} catch (error) {
  console.error("Update failed:", error.message);
  process.exit(1);
} finally {
  // Cleanup the temporary directory
  fs.rmSync(tempDir, { recursive: true, force: true });
}
