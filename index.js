const core = require("@actions/core");
const { HttpClient } = require("@actions/http-client");
// const tc = require("@actions/tool-cache");
// const { Octokit } = require("@octokit/rest");
const { create } = require("@actions/artifact");
const path = require("path");
const fs = require("fs");
const tar = require("tar");
const semver = require("semver");
const { execSync } = require("child_process");
const BUCKET_URL = "https://fcli-binaries.s3.eu-west-1.amazonaws.com/";
const SUPPORTED_PLATFORMS = [
  "linux-x86_64",
  "linux-arm64",
  "darwin-x86_64",
  "darwin-arm64",
];

function mapPlatform() {
  const os = process.platform;
  const arch = process.arch;
  const platform = `${os}-${arch}`;
  const platformMappings = {
    "linux-x64": "linux-x86_64",
    "darwin-x64": "darwin-x86_64",
    "linux-arm64": "linux-arm64",
    "darwin-arm64": "darwin-arm64",
  };
  return platformMappings[platform] || platform;
}

async function createTempDir(prefix) {
  const tempDirectory = process.env.RUNNER_TEMP;

  const uniqueTempDir = path.join(
    tempDirectory,
    `${prefix}-${Date.now()}`,
  );
  await fs.mkdirSync(uniqueTempDir, { recursive: true });
  return uniqueTempDir;
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
  const uniqueTempDir = createTempDir(artifactName);
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
  const platform = mapPlatform();
  const httpClient = new HttpClient("action");
  const jsonUrl = `${BUCKET_URL}versions/fluence-${platform}-tar-gz.json`;

  try {
    const response = await httpClient.get(jsonUrl);
    const versionsData = JSON.parse(await response.readBody());

    if (!versionsData[version]) {
      throw new Error(
        `Version ${version} not found. Available versions are: ${
          Object.keys(versionsData).join(", ")
        }`,
      );
    }
    const tarUrl = versionsData[version];
    const tarFileName = path.basename(new URL(tarUrl).pathname);
    const tarResponse = await httpClient.get(tarUrl);
    const uniqueTempDir = createTempDir(`fluence-${version}`);
    const tarFilePath = path.join(uniqueTempDir, tarFileName);
    fs.writeFileSync(tarFilePath, await tarResponse.readBody());
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

async function run() {
  try {
    const platform = mapPlatform();
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    const artifactName = core.getInput("artifact");
    let fluencePath;

    if (artifactName) {
      core.info(`Trying to download artifact with a name ${artifactName}`);
      try {
        fluencePath = await downloadArtifact(artifactName);
        await setupBinary(fluencePath);
        return;
      } catch (error) {
        core.warning(
          `Failed to download artifact with a name ${artifactName}: ${error}. Fallback to releases.`,
        );
      }
    }

    const version = core.getInput("version");

    const httpClient = new HttpClient("action");
    const response = await httpClient.get(BUCKET_URL + "channels");
    const channels = await response.readBody();

    if (semver.valid(version)) {
      core.info(
        `${version} appears to be a semver, trying to download fcli from releases`,
      );
      fluencePath = await downloadRelease(version);
      await setupBinary(fluencePath);
      return;
    } else if (channels.includes(version)) {
      core.info("channels");
      core.info(`${channels}`);
    } else {
      throw new Error("Invalid version or channel.");
    }
  } catch (error) {
    core.error(error);
  }
}

run();
