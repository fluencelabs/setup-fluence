const https = require("https");
const core = require("@actions/core");
const { HttpClient } = require("@actions/http-client");
const path = require("path");
const fs = require("fs");
const tar = require("tar");
const semver = require("semver");
const { execSync } = require("child_process");

const BUCKET_URL = "https://fcli-binaries.s3.eu-west-1.amazonaws.com";
const PLATFORM = `${process.platform}-${process.arch}`;
const SUPPORTED_PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
];

async function getAvailableChannels(predefinedChannels) {
  const httpClient = new HttpClient("action");
  let availableChannels = [];

  for (const channel of predefinedChannels) {
    const url = `${BUCKET_URL}/channels/${channel}/fluence-${PLATFORM}.tar.gz`;
    const response = await httpClient.head(url);

    if (response.message.statusCode === 200) {
      availableChannels.push(channel);
    }
  }

  return availableChannels;
}

async function createTempDir(prefix) {
  const tempDirectory = process.env.RUNNER_TEMP;
  const uniqueTempDir = path.join(
    tempDirectory,
    `${prefix}-${Date.now()}`,
  );
  await fs.promises.mkdir(uniqueTempDir, { recursive: true });
  return uniqueTempDir;
}

function downloadFile(url, destinationPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destinationPath);
    https.get(url, (response) => {
      const totalLength = parseInt(response.headers["content-length"], 10);
      let downloadedLength = 0;
      let lastLoggedProgress = 0;

      response.on("data", (chunk) => {
        downloadedLength += chunk.length;
        const progress = Math.floor(downloadedLength / totalLength * 100);

        if (progress >= lastLoggedProgress + 5) {
          lastLoggedProgress = progress;
          console.log(`Downloading: ${progress}%`);
        }
      });

      response.pipe(file);

      file.on("finish", () => {
        file.close(resolve);
      });
    }).on("error", (error) => {
      fs.unlink(destinationPath, () => reject(error));
    });
  });
}

function extractTarGz(filePath, destination) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(tar.x({ C: destination }))
      .on("error", reject)
      .on("end", resolve);
  });
}

async function setupBinary(fluencePath) {
  const binDir = path.resolve(path.dirname(fluencePath), "../../../bin");
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }
  const symlinkPath = path.join(binDir, "fluence");
  if (!fs.existsSync(symlinkPath)) {
    fs.symlinkSync(fluencePath, symlinkPath, "file");
  }
  core.addPath(binDir);
  await execSync("fluence dep versions", { stdio: "inherit" });
}

async function downloadArtifact(artifactName) {
  const uniqueTempDir = await createTempDir(artifactName);
  const artifactClient = create();

  try {
    const downloadResponse = await artifactClient.downloadArtifact(
      artifactName,
      uniqueTempDir,
    );
    const [tarFile] = fs.readdirSync(downloadResponse.downloadPath);

    if (tarFile.endsWith(".tar.gz")) {
      const tarFilePath = path.join(downloadResponse.downloadPath, tarFile);
      await extractTarGz(tarFilePath, uniqueTempDir);
    } else {
      throw new Error("No fcli tar archive found in the downloaded artifact.");
    }

    const fluenceBinaryPath = path.join(uniqueTempDir, "fluence/bin/fluence");

    if (fs.existsSync(fluenceBinaryPath)) {
      return fluenceBinaryPath;
    } else {
      throw new Error(`Expected binary not found at: ${fluenceBinaryPath}`);
    }
  } catch (error) {
    throw new Error(
      `An error occurred while processing the artifact: ${error.message}`,
    );
  }
}

async function downloadRelease(version) {
  const httpClient = new HttpClient("action");
  const jsonUrl = `${BUCKET_URL}/versions/fluence-${PLATFORM}-tar-gz.json`;

  try {
    const response = await httpClient.get(jsonUrl);
    const versionsData = JSON.parse(await response.readBody());

    if (!versionsData[version]) {
      const availableVersions = Object.keys(versionsData).join(", ");
      throw new Error(
        `Version ${version} not found. Available versions are: ${availableVersions}`,
      );
    }

    const tarUrl = versionsData[version];
    const tarFileName = path.basename(new URL(tarUrl).pathname);
    const uniqueTempDir = await createTempDir(`fluence-${version}`);
    const tarFilePath = path.join(uniqueTempDir, tarFileName);

    core.info(`Downloading fcli version ${version} from ${tarUrl}`);
    await downloadFile(tarUrl, tarFilePath);
    await extractTarGz(tarFilePath, uniqueTempDir);

    const fluenceBinaryPath = path.join(uniqueTempDir, "fluence/bin/fluence");
    if (fs.existsSync(fluenceBinaryPath)) {
      return fluenceBinaryPath;
    } else {
      throw new Error(`Expected binary not found at: ${fluenceBinaryPath}`);
    }
  } catch (error) {
    core.error(error);
    throw error;
  }
}

async function downloadChannel(channel) {
  const tarUrl = `${BUCKET_URL}/channels/${channel}/fluence-${PLATFORM}.tar.gz`;
  const tarFileName = path.basename(new URL(tarUrl).pathname);
  const uniqueTempDir = await createTempDir(`fluence-${channel}`);
  const tarFilePath = path.join(uniqueTempDir, tarFileName);

  core.info(`Downloading fcli from channel ${channel} from ${tarUrl}`);
  await downloadFile(tarUrl, tarFilePath);
  await extractTarGz(tarFilePath, uniqueTempDir);

  const fluenceBinaryPath = path.join(uniqueTempDir, "fluence/bin/fluence");
  if (fs.existsSync(fluenceBinaryPath)) {
    return fluenceBinaryPath;
  } else {
    throw new Error(`Expected binary not found at: ${fluenceBinaryPath}`);
  }
}

async function run() {
  try {
    if (!SUPPORTED_PLATFORMS.includes(PLATFORM)) {
      throw new Error(`Unsupported platform: ${PLATFORM}`);
    }

    let fluencePath;
    const artifactName = core.getInput("artifact");

    if (artifactName) {
      try {
        core.info(`Attempting to download artifact: ${artifactName}`);
        fluencePath = await downloadArtifact(artifactName);
        await setupBinary(fluencePath);
        return;
      } catch (error) {
        core.warning(
          `Failed to download artifact ${artifactName} with ${error}. Falling back to releases.`,
        );
      }
    }

    const version = core.getInput("version");
    const channels = await getAvailableChannels();

    if (channels.includes(version)) {
      fluencePath = await downloadChannel(version);
    } else if (semver.valid(version)) {
      fluencePath = await downloadRelease(version);
    } else {
      throw new Error(
        `Invalid input. Available channels: ${channels.join(", ")}`,
      );
    }

    await setupBinary(fluencePath);
  } catch (error) {
    core.setFailed(error);
  }
}

run();
