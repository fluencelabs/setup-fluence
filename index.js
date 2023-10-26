const core = require("@actions/core");
const tc = require("@actions/tool-cache");
const { Octokit } = require("@octokit/rest");
const { create } = require("@actions/artifact");
const path = require("path");
const fs = require("fs");
const { execSync } = require('child_process');
const BUCKET_URL = "https://fcli-binaries.s3.eu-west-1.amazonaws.com/";
const SUPPORTED_PLATFORMS = [
  "linux-x86_64",
  "linux-arm64",
  "darwin-x86_64",
  "darwin-arm64"
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

async function downloadArtifact(artifactName) {
  const artifactClient = create();
  const tempDirectory = process.env.RUNNER_TEMP;

  const uniqueTempDir = path.join(
    tempDirectory,
    `fluence-artifact-${Date.now()}`,
  );
  fs.mkdirSync(uniqueTempDir, { recursive: true });

  const downloadResponse = await artifactClient.downloadArtifact(
    artifactName,
    uniqueTempDir,
  );

  const fluenceBinaryPath = path.join(downloadResponse.downloadPath, "fluence/bin/fluence");

  if (fs.existsSync(fluenceBinaryPath)) {
    return fluenceBinaryPath;
  } else {
    throw new Error(
      `Expected fluence binary not found in the artifact at path: ${fluenceBinaryPath}`,
    );
  }
}

async function setupBinary(fluencePath) {
    core.addPath(fluencePath);
    execSync(`${fluencePath}/fluence --version`, { stdio: 'inherit' });
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
                core.warning(`Failed to download artifact with name ${artifactName}. Fallback to releases.`);
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
