const core = require("@actions/core");
// const tc = require("@actions/tool-cache");
// const { Octokit } = require("@octokit/rest");
const { create } = require("@actions/artifact");
const path = require("path");
const fs = require("fs");
const tar = require("tar");
const { execSync } = require("child_process");
// const BUCKET_URL = "https://fcli-binaries.s3.eu-west-1.amazonaws.com/";
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
  fs.createReadStream(filePath)
    .pipe(tar.x({ C: destination }))
    .on(
      "error",
      (err) =>
        core.error(
          `An error occurred while unpacking: ${err}`,
        ),
    )
    .on(
      "end",
      () => core.debug("Unpacking complete"),
    );
}

async function downloadArtifact(artifactName) {
  const artifactClient = create();
  const tempDirectory = process.env.RUNNER_TEMP;

  const uniqueTempDir = path.join(
    tempDirectory,
    `${artifactName}-${Date.now()}`,
  );
  fs.mkdirSync(uniqueTempDir, { recursive: true });

  const downloadResponse = await artifactClient.downloadArtifact(
    artifactName,
    uniqueTempDir,
  );

  if (downloadResponse.downloadPath) {
    fs.readdirSync(uniqueTempDir).forEach((file) => {
      if (/fluence-.*\.tar\.gz$/.test(file)) {
        extractTarGz(path.join(uniqueTempDir, file), uniqueTempDir);
      }
    });
  const ls = execSync(`ls -alh ${uniqueTempDir}`)
  core.info(`${ls}`)

    const fluenceBinaryPath = path.join(
      uniqueTempDir,
      "fluence/bin/fluence",
    );

    if (fs.existsSync(fluenceBinaryPath)) {
      return fluenceBinaryPath;
    } else {
      throw new Error(
        `Expected fcli binary not found at: ${fluenceBinaryPath}`,
      );
    }
  } else {
    throw new Error(`Artifact ${artifactName} could not be downloaded`);
  }
}

function setupBinary(fluencePath) {
  core.addPath(fluencePath);
  execSync(`${fluencePath} --version`, { stdio: "inherit" });
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
        setupBinary(fluencePath);
        return;
      } catch (_error) {
        core.warning(
          `Failed to download artifact with name ${artifactName}. Fallback to releases.`,
        );
      }
    }

    // let version = core.getInput("version");
    // if (version === "latest") {
    //     version = await getLatestVersionFromReleases();
    //     core.info(`Latest fluence release is v${version}`);
    // } else {
    //     version = version.replace(/^v/, "");
    // }

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
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
