const artifact = require("@actions/artifact");
const core = require("@actions/core");
const exec = require("@actions/exec");
const httpClient = require("@actions/http-client");
const fs = require("fs");

async function run() {
    try {
        if(process.env.GITHUB_WORKFLOW !== "autofix.ci") {
            throw new Error(`For security reasons, the workflow in which the autofix.ci action is used must be named "autofix.ci".`);
        }

        const event = JSON.parse(
            await fs.promises.readFile(process.env.GITHUB_EVENT_PATH, {encoding: 'utf8'})
        );

        if(core.isDebug()) {
            console.log(event);
        }

        let ok = await exec.exec("git", ["add", "--all"]);
        if (ok !== 0) {
            throw new Error("Failed to stage files.");
        }

        // Git consistently uses unix-style paths, so we do not need to worry about path conversions.
        let {exitCode, stdout, stderr} = await exec.getExecOutput("git", ["diff", "--name-only", "--staged"])
        if (exitCode !== 0) {
            console.error(stdout);
            console.error(stderr);
            throw new Error("Failed to find changed files.");
        }

        if (stdout === "") {
            console.log("Nothing to do! ✨");
            return;
        }

        let changes = stdout.trim().split("\n");
        console.log(`Need to update ${changes.length} files.`);

        const fileChanges = {
            additions: [],
            deletions: []
        };

        await Promise.all(changes.map((async (filename) => {
            let buf;
            try {
                buf = await fs.promises.readFile(filename);
            } catch (e) {
                fileChanges.deletions.push({path: filename})
                return;
            }
            fileChanges.additions.push({
                path: filename,
                contents: buf.toString("base64")
            });
        })));

        if (core.isDebug()) {
            console.log(fileChanges);
        }

        const client = artifact.create();

        const filename = "autofix.json";
        try {
            await fs.promises.writeFile(filename, JSON.stringify(fileChanges));
            await client.uploadArtifact("autofix.ci", [filename], ".", {
                continueOnError: false,
                retentionDays: 1
            });
        } finally {
            await fs.promises.rm(filename, {maxRetries: 3});
        }

        const url = (
            "https://api.autofix.ci/fix" +
            "?owner=" + encodeURIComponent(event.repository.owner.login) +
            "&repo=" + encodeURIComponent(event.repository.name) +
            "&pull=" + encodeURIComponent(event.pull_request.number)
        )
        const http = new httpClient.HttpClient("autofix-action/v1");
        const resp = await http.post(url, null);
        const body = await resp.readBody();
        if (resp.message.statusCode === 200) {
            core.setFailed("Need to update files.");
            // show the user what needs to be changed.
            await exec.exec("git", ["diff", "--staged"])
        } else {
            console.log(resp.message.statusCode, body);
            core.setFailed(body);
        }
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
