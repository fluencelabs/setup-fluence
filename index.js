const axios = require("axios");
const core = require("@actions/core");
const { DefaultArtifactClient } = require("@actions/artifact");
const { HttpClient } = require("@actions/http-client");
const path = require("path");
const fs = require("fs");
const tar = require("tar");
const semver = require("semver");
const { execSync } = require("child_process");
const unzipper = require("unzipper");

const BUCKET_URL = "https://fcli-binaries.s3.eu-west-1.amazonaws.com";
const PLATFORM = `${process.platform}-${process.arch}`;
const SUPPORTED_PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
];
const CHANNELS = [
  "kras",
  "testnet",
  "stage",
  "latest",
  "stable",
  "main",
  "unstable",
];

const NoArtifactOptions = {
  warn: "warn",
  error: "error",
  ignore: "ignore",
};

function isValidHttpUrl(string) {
  let url;

  try {
    url = new URL(string);
  } catch (_) {
    return false;
  }

  return url.protocol === "http:" || url.protocol === "https:";
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

function downloadFile(url, destinationPath, headers) {
  core.info(`Downloading ${url}`);

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destinationPath);

    const response = axios({
      method: "get",
      url: url,
      responseType: "stream",
      headers,
    });

    response.then((axiosResponse) => {
      const totalLength = parseInt(axiosResponse.headers["content-length"], 10);
      let downloadedLength = 0;
      let lastLoggedProgress = 0;

      axiosResponse.data.on("data", (chunk) => {
        downloadedLength += chunk.length;
        const progress = Math.floor((downloadedLength / totalLength) * 100);

        if (progress >= lastLoggedProgress + 5) {
          lastLoggedProgress = progress;
          core.info(`Downloading: ${progress}%`);
        }
      });

      axiosResponse.data.pipe(writer);

      writer.on("finish", () => {
        writer.close();
        resolve();
      });
    }).catch((error) => {
      reject(error);
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

async function setupBinary(dir) {
  const fluencePath = path.resolve(dir + "/fluence/bin/fluence");
  if (!fs.existsSync(fluencePath)) {
    throw new Error(`Expected binary not found at: ${fluencePath}`);
  }

  const binDir = path.resolve(dir + "/bin");
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

async function downloadArtifact(artifact) {
  const uniqueTempDir = await createTempDir(artifact);
  let zipFilePath;

  try {
    // Check if artifact is a URL
    if (isValidHttpUrl(artifact)) {
      const fileName = path.basename(new URL(artifact).pathname);
      zipFilePath = path.join(uniqueTempDir, fileName);
      const headers = {};
      if (artifact.includes("github.com")) {
        headers["Authorization"] = `token ${process.env.GITHUB_TOKEN}`;
      }
      console.log(headers);

      await downloadFile(artifact, zipFilePath, headers);
    } else {
      // Use artifact client to download the artifact
      const artifactClient = new DefaultArtifactClient();
      const artifactId = artifactClient.getArtifact(artifact);
      const downloadResponse = await artifactClient.downloadArtifact(
        artifactId,
        { uniqueTempDir },
      );
      const [zipFile] = fs.readdirSync(downloadResponse.downloadPath);

      if (!zipFile.endsWith(".zip")) {
        throw new Error("No zip archive found in the downloaded artifact.");
      }
      zipFilePath = path.join(downloadResponse.downloadPath, zipFile);
    }

    // Extract the zip file
    const zipExtractPath = path.join(uniqueTempDir, "extracted");
    await fs.promises.mkdir(zipExtractPath, { recursive: true });
    await unzipper.Open.file(zipFilePath)
      .then((d) => d.extract({ path: zipExtractPath }));

    // Find the .tar.gz file inside the extracted directory and extract it
    const extractedFiles = fs.readdirSync(zipExtractPath);
    const tarGzFile = extractedFiles.find((file) => file.endsWith(".tar.gz"));
    if (!tarGzFile) {
      throw new Error("No .tar.gz file found inside the zip archive.");
    }

    const tarGzFilePath = path.join(zipExtractPath, tarGzFile);
    await extractTarGz(tarGzFilePath, uniqueTempDir);

    return uniqueTempDir;
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

    core.info(`Downloading fcli version ${version}`);
    await downloadFile(tarUrl, tarFilePath);
    await extractTarGz(tarFilePath, uniqueTempDir);

    return uniqueTempDir;
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

  core.info(`Downloading fcli from channel ${channel}`);
  await downloadFile(tarUrl, tarFilePath);
  await extractTarGz(tarFilePath, uniqueTempDir);

  return uniqueTempDir;
}

async function run() {
  try {
    if (!SUPPORTED_PLATFORMS.includes(PLATFORM)) {
      throw new Error(`Unsupported platform: ${PLATFORM}`);
    }

    const ifNoArtifactFound = core.getInput("if-no-artifact-found");
    const noArtifactBehavior = NoArtifactOptions[ifNoArtifactFound];

    if (!noArtifactBehavior) {
      core.setFailed(
        `Unrecognized 'if-no-artifact-found' input. Provided: ${ifNoArtifactFound}. Available options: ${
          Object.keys(
            NoArtifactOptions,
          )
        }`,
      );
    }

    let fluencePath;
    const artifact = core.getInput("artifact");

    if (artifact) {
      try {
        core.info(`Attempting to download artifact: ${artifact}`);
        fluencePath = await downloadArtifact(artifact);
        await setupBinary(fluencePath);
        return;
      } catch (error) {
        switch (ifNoArtifactFound) {
          case NoArtifactOptions.warn: {
            core.warning(
              `Failed to download artifact '${artifact}' with error:
              ${error}.
              Falling back to releases.`,
            );
            break;
          }
          case NoArtifactOptions.error: {
            core.setFailed(
              `Failed to download artifact '${artifact}' with error:
              ${error}`,
            );
            process.exit(1);
            break;
          }
          case NoArtifactOptions.ignore: {
            core.info(
              `Failed to download artifact '${artifact}' with error:
              ${error}
              Falling back to releases.`,
            );
            break;
          }
        }
      }
    }

    let version = core.getInput("version");

    if (CHANNELS.includes(version)) {
      fluencePath = await downloadChannel(version);
    } else if (semver.valid(version)) {
      version = version.replace(/^v/, "");
      fluencePath = await downloadRelease(version);
    } else {
      throw new Error(
        `Invalid input 'version'. Available channels: ${CHANNELS.join(", ")}`,
      );
    }

    await setupBinary(fluencePath);
  } catch (error) {
    core.setFailed(error);
  }
}

run();
