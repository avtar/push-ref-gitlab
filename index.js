#!/usr/bin/env node

"use strict";

var https = require('https'),
    qs = require('querystring'),
    url = require('url'),
    fs = require("fs"),
    spawn = require("child_process").spawn,
    argv = require('minimist')(process.argv.slice(2), {
        boolean: ["gitlab-enable-shared-runners"],
        default: {
            "gitlab-enable-shared-runners": false,
            "gitlab-instance": "https://gitlab.com",
            cwd: process.cwd()
        }
    });

var BENIGN_ERRORS = [
    "Runner was already enabled for this project",
    "404 Project Not Found"
];

var BUILD_EVENTS_WEBHOOK_URL = argv['build-events-webhook-url'];

var GITLAB_HOST = argv['gitlab-instance'];
var GITLAB_USER = argv['gitlab-repo-owner'];
var GITLAB_REPO = argv['gitlab-repo-name'];

var GITHUB_REF = argv['ref'].split("/").slice(-1)[0];
var GITHUB_USER = argv['github-repo-owner'];
var GITHUB_REPO = argv['github-repo-name'];

var GITLAB_TOKEN = argv['gitlab-token'];

var GITLAB_ENABLE_SHARED_RUNNERS = argv['gitlab-enable-shared-runners'];
var GITLAB_RUNNER_ID = argv['gitlab-runner-id'];
var CWD = argv['cwd'];

var GITLAB_USER_AND_REPO = GITLAB_USER + "%2F" + GITLAB_REPO;


function pathExists (path) {
    try {
        fs.statSync(path);
        return true;
    } catch (err) {
        return false;
    }
}

function makeGitlabRequest (path, data) {
    var headers = {
        "PRIVATE-TOKEN": GITLAB_TOKEN
    };

    if (data) {
        data = qs.stringify(data);
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(data);
    }

    var parsed = url.parse(GITLAB_HOST);
    return new Promise(function (resolve, reject) {
        var request = https.request({
            host: parsed.host,
            port: parsed.port || '443',
            path: "/api/v3/" + path,
            method: data ? 'POST' : 'GET',
            headers: headers
        }, function (res) {
            res.setEncoding("utf8");
            var body = "";
            res.on("data", function (data) {
                body += data;
            }).on("error", function (e) {
                e.res = res;
                reject(e);
            }).on("end", function () {
                try {
                    body = JSON.parse(body)
                } catch (e) {}

                // Let's start panicking here if we get client or server errors, or if the message
                // returned by Gitlab is something other than what we expect.
                if (res.statusCode >= 400 && BENIGN_ERRORS.indexOf(body.message) === -1) {
                    reject(body);
                } else {
                    body.res = res;
                    resolve(body);
                }
            });
        }).on("error", function (e) {
            reject(e);
        });

        // Handle post data
        if (data) {
            request.write(data, "utf8");
        }

        request.end();
    });
}

function doesGitlabProjectExist (repo, account) {
    return makeGitlabRequest("projects/" + account + "%2F" + repo).then(function (data) {
        data = data || {};
        data.projectExists = data.res.statusCode !== 404;
        return data;
    });
}

// Shared runners are being disabled because the ones provided by gitlab.com will not provide
// IDI supported environments
function createGitlabProject (repo, account) {
    return makeGitlabRequest('/projects', {
        name: repo,
        public: "true",
        shared_runners_enabled: GITLAB_ENABLE_SHARED_RUNNERS,
        issues_enabled: "false"
    });
}

function ensureGitlabProjectExists (repo, account) {
    console.log("Checking if " + GITLAB_REPO + " project exists...");
    return doesGitlabProjectExist(GITLAB_REPO, GITLAB_USER).then(function (data) {
        console.log(GITLAB_REPO + " project " + (data.projectExists ? "exists" : "doesn't exist."));
        if (data.projectExists) {
            return data;
        }

        console.log("Creating the project.");
        return createGitlabProject(repo, account);
    });
}

function enableGitlabRunner (projectId) {
    return makeGitlabRequest('/projects/' + projectId + '/runners', {
        runner_id: GITLAB_RUNNER_ID
    });
}

function addGitlabBuildEventsHook (projectFullName, webhookUrl) {
    return makeGitlabRequest('projects/' + projectFullName + '/hooks', {
        url: webhookUrl,
        build_events: "true",
        push_events: "false"
    });
}

function git (command, args, opts) {
    opts = opts || {};
    opts.stdio = ["pipe", "pipe", "inherit"];
    return new Promise(function (resolve, reject) {
        var proc = spawn("git", [command].concat(args), opts);
        var output = "";
        proc.stdout.on("data", function (chunk) {
            output += chunk;
        });

        proc.on("error", reject).on("close", function (exitCode) {
            if (exitCode !== 0) {
                console.warn("The git command returned non-zero exit code!");
            }
            resolve(output.trim());
        });
    });
}

function cloneRepo (owner, repo, outputDir) {
    return git("clone", ["https://github.com/" + owner + "/" + repo, outputDir]);
}

function addRemote (name, owner) {
    var dir = getRepoWorkingDirPath(name, owner);
    return git("remote", [
        "add",
        "gitlab",
        "https://" + GITLAB_USER + ":" + GITLAB_TOKEN + "@" + url.parse(GITLAB_HOST).host + "/" + GITLAB_USER + "/" + GITLAB_REPO + ".git"
    ], {
        cwd: dir
    });
}

function getGitlabRemote (name, owner) {
    var dir = getRepoWorkingDirPath(name, owner);
    return new Promise(function (res, rej) {
        // If there's no remote and that causes a failure here, let's resolve with an empty string
        git("remote", [
            "remove",
            "gitlab"
        ], {
            cwd: dir
        }).then(function (url) {
            res(url);
        }).catch(function (e) {
            res("");
        });
    });
}

// Takes git ref arg and pushes to Gitlab remote of repo arg
function pushRef (name, owner, ref) {
    var dir = getRepoWorkingDirPath(name, owner);
    return git("push", [
        "gitlab",
        "origin/" + GITHUB_REF + ":refs/heads/" + GITHUB_REF,
        "--force"
    ], {
        cwd: dir
    });
}

function getRepoWorkingDirPath (name, owner) {
    return CWD + "/" + name + "_" + owner;
}

function ensureRepoWorkingDirExists (name, owner) {
    var dir = getRepoWorkingDirPath(name, owner);
    if (pathExists(dir)) {
        return new Promise(function (res) {
            res(true);
        });
    }
    return cloneRepo(GITHUB_USER, GITHUB_REPO, dir);
}

function ensureRepoRemoteExists (name, owner) {
    return getGitlabRemote(name, owner).then(function (url) {
        return addRemote(name, owner);
    });
}

console.log("Ensuring the project exists...");
ensureGitlabProjectExists(GITLAB_REPO, GITLAB_USER).then(function (data) {
    // Add the CI runner's ID
    console.log("Enabling the CI runner...");
    return enableGitlabRunner(data.id)
}).then(function (data) {
    console.log("Adding build events hook URL...");
    return addGitlabBuildEventsHook(GITLAB_USER_AND_REPO, BUILD_EVENTS_WEBHOOK_URL);
}).then(function (data) {
    console.log("The build events hook was created.");
    console.log("Cloning the repository: " + GITHUB_USER + "/" + GITHUB_REPO);
    return ensureRepoWorkingDirExists(GITHUB_REPO, GITHUB_USER);
}).then(function (data) {
    console.log("The repository exists on the disk.");
    console.log("Making sure the Gitlab remote exists...");
    return ensureRepoRemoteExists(GITHUB_REPO, GITHUB_USER);
}).then(function (data) {
    console.log("Added the Gitlab remote.");
    console.log("Pushing the ref...");
    return pushRef(GITHUB_REPO, GITHUB_USER, GITHUB_REF);
}).then(function () {
    console.log("Pushed the ref to Gitlab.");
}).catch(function (e) {
    console.error(e.stack || e);
});
