const core = require("@actions/core");
const { HttpClient } = require("@actions/http-client");
// const tc = require("@actions/tool-cache");
// const { Octokit } = require("@octokit/rest");
const { create } = require("@actions/artifact");
const path = require("path");
const fs = require("fs");
const tar = require("tar");
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

function extractTarGz(filePath, destination) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(tar.x({ C: destination }))
      .on("error", reject)
      .on("end", resolve);
  });
}

async function setupBinary(fluencePath) {
  const target = path.resolve(fluencePath, "../..");
  fs.symlinkSync(fluencePath, target + "/fluence", "file");
  core.addPath(path.dirname(target));
  await execSync(`fluence --version`, { stdio: "inherit" });
}

async function downloadArtifact(artifactName) {
  const artifactClient = create();
  const tempDirectory = process.env.RUNNER_TEMP;

  const uniqueTempDir = path.join(
    tempDirectory,
    `${artifactName}-${Date.now()}`,
  );
  fs.mkdirSync(uniqueTempDir, { recursive: true });

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

async function run() {
  try {
    const platform = mapPlatform();
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    const artifactName = core.getInput("artifact-name");
    let fluencePath;

    if (artifactName) {
      try {
        fluencePath = await downloadArtifact(artifactName);
        await setupBinary(fluencePath);
        return;
      } catch (_error) {
        core.warning(
          `Failed to download artifact with name ${artifactName}. Fallback to releases.`,
        );
      }
    }

    const version = core.getInput("version");

    const httpClient = new HttpClient("action");
    const channels = await httpClient.get(BUCKET_URL + "channels").readBody();

    if (semver.valid(version)) {
      core.info("downloading version todo");
    } else if (channels.includes(version)) {
      core.info("channels");
      core.info(`${channels}`);
    } else {
      throw new Error("Invalid version or channel.");
    }
  } catch {
    core.error(error);
  }

  // const filename = `marine`;
  // const downloadUrl = `${BUCKET_URL}marine-v${version}/${filename}-${platform}`;
  // const cachedPath = tc.find("marine", version, platform);

  // if (!cachedPath) {
  //     const downloadPath = await tc.downloadTool(downloadUrl);
  //     marinePath = await tc.cacheFile(downloadPath, filename, "marine", version);
  // } else {
  //     marinePath = cachedPath;
  // }

  // await setupBinary(marinePath);
  // } catch (error) {
  // core.setFailed(error.message);
  // }
}

run();
