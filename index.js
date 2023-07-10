const artifact = require("@actions/artifact");
const core = require("@actions/core");
const exec = require("@actions/exec");
const httpClient = require("@actions/http-client");
const fs = require("fs");

async function run() {
    try {
        if (process.env.GITHUB_WORKFLOW !== "autofix.ci") {
            throw new Error(`For security reasons, the workflow in which the autofix.ci action is used must be named "autofix.ci".`);
        }

        const event = JSON.parse(
            await fs.promises.readFile(process.env.GITHUB_EVENT_PATH, {encoding: 'utf8'})
        );
        if (core.isDebug()) {
            console.log(event);
        }

        let ok = await exec.exec("git", ["reset"]);
        if (ok !== 0) {
            throw new Error("Failed to reset files.");
        }

        ok = await exec.exec("git", ["-c", "core.fileMode=false", "add", "--all"]);
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
        // UX: Already check here if we have forbidden files.
        // This is truly enforced on the server, but this way we can give a better error message.
        if(changes.some((path) => path.includes(".github"))) {
            throw new Error("The autofix.ci action is not allowed to modify the .github directory.");
        }
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
            await fs.promises.writeFile(filename, JSON.stringify({
                version: 1,
                changes: fileChanges,
                failFast: core.getInput("fail-fast") === "true",
                commitMessage: core.getInput("commit-message") || undefined,
            }));
            await client.uploadArtifact("autofix.ci", [filename], ".", {
                continueOnError: false,
                retentionDays: 1
            });
        } finally {
            await fs.promises.rm(filename, {maxRetries: 3});
        }

        let url = (
            "https://api.autofix.ci/fix" +
            "?owner=" + encodeURIComponent(event.repository.owner.login) +
            "&repo=" + encodeURIComponent(event.repository.name)
        )
        if (event.pull_request) {
            url += "&pull=" + encodeURIComponent(event.pull_request.number);
        } else {
            url += "&branch=" + encodeURIComponent(event.ref.replace(/^refs\/heads\//, ""));
        }

        const http = new httpClient.HttpClient("autofix-action/v1");
        const resp = await http.post(url, null);
        const body = await resp.readBody();
        if (resp.message.statusCode === 200) {
            core.setFailed("✅ Autofix task started.");
        } else {
            console.log(resp.message.statusCode, body);
            core.setFailed(body);
        }
        // show the user what needs to be changed.
        await exec.exec("git", ["diff", "--staged"]);
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
