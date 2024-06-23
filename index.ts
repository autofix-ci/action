import {DefaultArtifactClient} from '@actions/artifact'
import {getInput, isDebug, setFailed, setOutput} from "@actions/core";
import {exec, getExecOutput} from "@actions/exec";
import {HttpClient} from "@actions/http-client";
import {readFile, rm, writeFile} from "fs/promises";


async function main() {
    setOutput('autofix_started', false);

    const event = JSON.parse(
        await readFile(process.env.GITHUB_EVENT_PATH, {encoding: 'utf8'})
    );
    if (isDebug()) {
        console.log(event);
    }

    if (process.env.GITHUB_WORKFLOW !== "autofix.ci") {
        throw `For security reasons, the workflow in which the autofix.ci action is used must be named "autofix.ci".`;
    }

    await exec("git", ["reset"]);

    await exec("git", ["-c", "core.fileMode=false", "add", "--all"]);

    // Git consistently uses unix-style paths, so we do not need to worry about path conversions.
    let {stdout} = await getExecOutput("git", ["diff", "--name-only", "--staged", "--no-renames"])
    if (stdout === "") {
        console.log("Nothing to do! ✨");
        return;
    }
    let changes = stdout.trim().split("\n");
    // UX: Already check here if we have forbidden files.
    // This is truly enforced on the server, but this way we can give a better error message.
    if (changes.some((path) => path.includes(".github"))) {
        throw "The autofix.ci action is not allowed to modify the .github directory.";
    }
    console.log(`Need to update ${changes.length} files.`);

    // For pull requests, we need to rebase the changes onto the PR head,
    // see https://github.com/autofix-ci/action/issues/12.
    if (event.pull_request) {
        // Create a commit
        await exec("git", ["config", "user.name", "autofix.ci"]);
        await exec("git", ["config", "user.email", "noreply@autofix.ci"]);
        await exec("git", [
            "commit",
            "-m", "autofix",
        ]);
        let commit_hash = (
            await getExecOutput("git", ["rev-parse", "HEAD"])
        ).stdout.trim();
        if (isDebug()) {
            await exec("git", ["show", commit_hash]);
        }
        // Fetch and check out PR head
        await exec("git", ["fetch", "--depth=1", "origin", `+refs/pull/${event.pull_request.number}/head`]);
        await exec("git", ["checkout", "--force", "FETCH_HEAD"]);
        if (isDebug()) {
            await exec("git", ["status"]);
        }
        // Reapply fixes.
        await exec("git", ["cherry-pick", "--no-commit", commit_hash]);
    }

    const fileChanges = {
        additions: [],
        deletions: []
    };
    await Promise.all(changes.map((async (filename) => {
        let buf: Buffer;
        try {
            buf = await readFile(filename);
        } catch (e) {
            fileChanges.deletions.push({path: filename})
            return;
        }
        fileChanges.additions.push({
            path: filename,
            contents: buf.toString("base64")
        });
    })));
    if (isDebug()) {
        console.log(fileChanges);
    }

    const client = new DefaultArtifactClient();

    const filename = "autofix.json";
    try {
        await writeFile(filename, JSON.stringify({
            version: 1,
            changes: fileChanges,
            failFast: getInput("fail-fast") === "true",
            comment: getInput("comment") || undefined,
            commitMessage: getInput("commit-message") || undefined,
        }));
        await client.uploadArtifact("autofix.ci", [filename], ".", {
            retentionDays: 1
        });
    } finally {
        await rm(filename, {maxRetries: 3});
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

    const http = new HttpClient("autofix-action/v2");
    const resp = await http.post(url, null);
    const body = await resp.readBody();
    if (resp.message.statusCode === 200) {
        setFailed("✅ Autofix task started.");
        setOutput('autofix_started', true);
    } else {
        console.log(resp.message.statusCode, body);
        setFailed(body);
    }
    // show the user what needs to be changed.
    await exec("git", ["diff", "--staged"]);
}

(async function run() {
    try {
        await main();
    } catch (error) {
        setFailed(String(error).replace(/^Error: /, ""));
    }
})();
