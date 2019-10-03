import assert = require("assert");
import { emptyDir } from "fs-extra";
import * as yargs from "yargs";

import { FS, getDefinitelyTyped } from "./get-definitely-typed";
import { Options } from "./lib/common";
import { CachedNpmInfoClient, NpmPublishClient, UncachedNpmInfoClient, withNpmCache } from "./lib/npm-client";
import { AllPackages, NotNeededPackage, readNotNeededPackages, TypingsData } from "./lib/packages";
import { outputDirPath, validateOutputPath } from "./lib/settings";
import { Semver } from "./lib/versions";
import { npmInstallFlags, readJson, sleep, writeFile, writeJson } from "./util/io";
import { logger, Logger, loggerWithErrors, writeLog } from "./util/logging";
import { assertDefined, best, computeHash, execAndThrowErrors, joinPaths, logUncaughtErrors, mapDefined } from "./util/util";

const typesRegistry = "types-registry";
const registryOutputPath = joinPaths(outputDirPath, typesRegistry);
const readme =
    `This package contains a listing of all packages published to the @types scope on NPM.
Generated by [types-publisher](https://github.com/Microsoft/types-publisher).`;

if (!module.parent) {
    const dry = !!yargs.argv.dry;
    logUncaughtErrors(async () => {
        const dt = await getDefinitelyTyped(Options.defaults, loggerWithErrors()[0]);
        await publishRegistry(dt, await AllPackages.read(dt), dry, new UncachedNpmInfoClient());
    });
}

export default async function publishRegistry(dt: FS, allPackages: AllPackages, dry: boolean, client: UncachedNpmInfoClient): Promise<void> {
    const [log, logResult] = logger();
    log("=== Publishing types-registry ===");

    const { npmVersion, highestSemverVersion, npmContentHash, lastModified } =
        await fetchAndProcessNpmInfo(typesRegistry, client);
    assert.strictEqual(npmVersion.major, 0);
    assert.strictEqual(npmVersion.minor, 1);

    // Don't include not-needed packages in the registry.
    const registryJsonData = await withNpmCache(client, cachedClient => generateRegistry(allPackages.allLatestTypings(), cachedClient));
    const registry = JSON.stringify(registryJsonData);
    const newContentHash = computeHash(registry);
    const newVersion = `0.1.${npmVersion.patch + 1}`;
    const isTimeForNewVersion = isSevenDaysAfter(lastModified);

    try {
        await publishToRegistry("github");
    } catch(e) {
        // log and continue
        log("publishing to github failed: " + e.toString());
    }
    await publishToRegistry("npm");
    await writeLog("publish-registry.md", logResult());

    async function publishToRegistry(registryName: "github" | "npm") {
        const packageName = registryName === "github" ? "@definitelytyped/" + typesRegistry : typesRegistry;
        const packageJson = generatePackageJson(packageName, registryName, newVersion, newContentHash);
        await generate(registry, packageJson);

        const publishClient = () => NpmPublishClient.create({ defaultTag: "next" }, registryName);
        if (!highestSemverVersion.equals(npmVersion)) {
            // There was an error in the last publish and types-registry wasn't validated.
            // This may have just been due to a timeout, so test if types-registry@next is a subset of the one we're about to publish.
            // If so, we should just update it to "latest" now.
            log("Old version of types-registry was never tagged latest, so updating");
            await validateIsSubset(await readNotNeededPackages(dt), log);
            await (await publishClient()).tag(packageName, highestSemverVersion.versionString, "latest", dry, log);
        } else if (npmContentHash !== newContentHash && isTimeForNewVersion) {
            log("New packages have been added, so publishing a new registry.");
            await publish(await publishClient(), packageName, packageJson, newVersion, dry, log);
        } else {
            const reason = npmContentHash === newContentHash ? "No new packages published" : "Was modified less than a week ago";
            log(`${reason}, so no need to publish new registry.`);
            // Just making sure...
            await validate(log);
        }
    }

}

const millisecondsPerDay = 1000 * 60 * 60 * 24;
function isSevenDaysAfter(time: Date): boolean {
    const diff = Date.now() - time.getTime();
    const days = diff / millisecondsPerDay;
    return days > 7;
}

async function generate(registry: string, packageJson: {}): Promise<void> {
    await emptyDir(registryOutputPath);
    await writeOutputJson("package.json", packageJson);
    await writeOutputFile("index.json", registry);
    await writeOutputFile("README.md", readme);

    function writeOutputJson(filename: string, content: object): Promise<void> {
        return writeJson(outputPath(filename), content);
    }

    function writeOutputFile(filename: string, content: string): Promise<void> {
        return writeFile(outputPath(filename), content);
    }

    function outputPath(filename: string): string {
        return joinPaths(registryOutputPath, filename);
    }
}

async function publish(client: NpmPublishClient, packageName: string, packageJson: {}, version: string, dry: boolean, log: Logger): Promise<void> {
    await client.publish(registryOutputPath, packageJson, dry, log);
    // Sleep for 60 seconds to let NPM update.
    if (dry) {
        log("(dry) Skipping 60 second sleep...");
    } else {
        log("Sleeping for 60 seconds ...");
        await sleep(60);
    }
    // Don't set it as "latest" until *after* it's been validated.
    await validate(log);
    await client.tag(packageName, version, "latest", dry, log);
}

async function installForValidate(log: Logger): Promise<void> {
    await emptyDir(validateOutputPath);
    await writeJson(joinPaths(validateOutputPath, "package.json"), {
        name: "validate",
        version: "0.0.0",
        description: "description",
        readme: "",
        license: "",
        repository: {},
    });

    const npmPath = joinPaths(__dirname, "..", "node_modules", "npm", "bin", "npm-cli.js");
    const cmd = `node ${npmPath} install types-registry@next ${npmInstallFlags}`;
    log(cmd);
    const err = (await execAndThrowErrors(cmd, validateOutputPath)).trim();
    if (err) {
        console.error(err);
    }
}

const validateTypesRegistryPath = joinPaths(validateOutputPath, "node_modules", "types-registry");

async function validate(log: Logger): Promise<void> {
    await installForValidate(log);
    const output = joinPaths(registryOutputPath, "index.json");
    const nodeModules = joinPaths(validateTypesRegistryPath, "index.json");
    log(`Checking that ${output} is newer than ${nodeModules}`);
    assertJsonNewer(await readJson(output), await readJson(nodeModules), log);
}

async function validateIsSubset(notNeeded: ReadonlyArray<NotNeededPackage>, log: Logger): Promise<void> {
    await installForValidate(log);
    const indexJson = "index.json";
    const actual = await readJson(joinPaths(validateTypesRegistryPath, indexJson)) as Registry;
    const expected = await readJson(joinPaths(registryOutputPath, indexJson)) as Registry;
    for (const key in actual.entries) {
        if (!(key in expected.entries) && !notNeeded.some(p => p.name === key)) {
            throw new Error(`Actual types-registry has unexpected key ${key}`);
        }
    }
}

function assertJsonNewer(newer: { [s: string]: any }, older: { [s: string]: any }, log: Logger, parent = "") {
    for (const key of Object.keys(older)) {
        if (!newer.hasOwnProperty(key)) {
            log(`${key} in ${parent} was not found in newer -- assumed to be deprecated.`);
            continue;
        }
        switch (typeof newer[key]) {
            case "string":
                const newerver = Semver.tryParse(newer[key]);
                const olderver = Semver.tryParse(older[key]);
                const condition = newerver && olderver ?
                    newerver.greaterThan(olderver) || newerver.equals(olderver) :
                    newer[key] >= older[key];
                assert(condition, `${key} in ${parent} did not match: newer[key] (${newer[key]}) < older[key] (${older[key]})`);
                break;
            case "number":
                assert(newer[key] >= older[key], `${key} in ${parent} did not match: newer[key] (${newer[key]}) < older[key] (${older[key]})`);
                break;
            case "boolean":
                assert(newer[key] === older[key], `${key} in ${parent} did not match: newer[key] (${newer[key]}) !== older[key] (${older[key]})`);
                break;
            default:
                assertJsonNewer(newer[key], older[key], log, key);
        }
    }
}

function generatePackageJson(name: string, registryName: "github" | "npm", version: string, typesPublisherContentHash: string): object {
    const json = {
        name,
        version,
        description: "A registry of TypeScript declaration file packages published within the @types scope.",
        repository: {
            type: "git",
            url: registryName === "github"
                ? "https://github.com/DefinitelyTyped/DefinitelyTyped.git"
                : "https://github.com/Microsoft/types-publisher.git",
        },
        keywords: [
            "TypeScript",
            "declaration",
            "files",
            "types",
            "packages",
        ],
        author: "Microsoft Corp.",
        license: "MIT",
        typesPublisherContentHash,
    };
    if (registryName === "github") {
        (json as any).publishConfig = { registry: "https://npm.pkg.github.com/" };
    }
    return json;
}

interface Registry {
    readonly entries: {
        readonly [packageName: string]: {
            readonly [distTags: string]: string,
        },
    };
}
async function generateRegistry(typings: ReadonlyArray<TypingsData>, client: CachedNpmInfoClient): Promise<Registry> {
    const entries: { [packageName: string]: { [distTags: string]: string } } = {};
    for (const typing of typings) {
        // Unconditionally use cached info, this should have been set in calculate-versions so should be recent enough.
        const info = client.getNpmInfoFromCache(typing.fullEscapedNpmName);
        if (!info) {
            const missings = typings.filter(t => !client.getNpmInfoFromCache(t.fullEscapedNpmName)).map(t => t.fullEscapedNpmName);
            throw new Error(`${missings} not found in cached npm info.`);
        }
        entries[typing.name] = filterTags(info.distTags);
    }
    return { entries };

    function filterTags(tags: Map<string, string>): { readonly [tag: string]: string; } {
        const latestTag = "latest";
        const latestVersion = tags.get(latestTag);
        const out: { [tag: string]: string } = {};
        tags.forEach((value, tag) => {
            if (tag === latestTag || value !== latestVersion) {
                out[tag] = value;
            }
        });
        return out;
    }
}

interface ProcessedNpmInfo {
    readonly npmVersion: Semver;
    readonly highestSemverVersion: Semver;
    readonly npmContentHash: string;
    readonly lastModified: Date;
}

async function fetchAndProcessNpmInfo(escapedPackageName: string, client: UncachedNpmInfoClient): Promise<ProcessedNpmInfo> {
    const info = assertDefined(await client.fetchNpmInfo(escapedPackageName));
    const npmVersion = Semver.parse(assertDefined(info.distTags.get("latest")));
    const { distTags, versions, time } = info;
    const highestSemverVersion = getLatestVersion(versions.keys());
    assert.strictEqual(highestSemverVersion.versionString, distTags.get("next"));
    const npmContentHash = versions.get(npmVersion.versionString)!.typesPublisherContentHash || "";
    return { npmVersion, highestSemverVersion, npmContentHash, lastModified: new Date(time.get("modified")!) };
}
function getLatestVersion(versions: Iterable<string>): Semver {
    return best(mapDefined(versions, v => Semver.tryParse(v)), (a, b) => a.greaterThan(b))!;
}
