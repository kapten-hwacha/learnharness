import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walkDirectory(dir: string, fileList: string[] = []): string[] {
	if (!fs.existsSync(dir)) return fileList;
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walkDirectory(fullPath, fileList);
		} else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) {
			fileList.push(fullPath);
		}
	}
	return fileList;
}

describe("electron retirement verification", () => {
	it("no source file requires electron", () => {
		const dirsToScan = ["electron", "src", "app", "components", "scripts"];
		const electronRequireRegex = /require\(["']electron["']\)|from ["']electron["']/;
		const violations: { file: string; line: number; match: string }[] = [];

		for (const dirName of dirsToScan) {
			const fullDir = path.join(ROOT, dirName);
			const files = walkDirectory(fullDir);
			for (const file of files) {
				const content = fs.readFileSync(file, "utf8");
				const lines = content.split("\n");
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (line !== undefined && electronRequireRegex.test(line)) {
						violations.push({
							file: path.relative(ROOT, file),
							line: i + 1,
							match: line.trim(),
						});
					}
				}
			}
		}

		assert.deepEqual(violations, [], `Found electron requires in source files:\n${JSON.stringify(violations, null, 2)}`);
	});

	it("package.json has no electron dependencies", () => {
		const pkgPath = path.join(ROOT, "package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

		assert.equal(pkg.main, undefined, "package.json must not have a 'main' field");
		assert.equal(pkg.desktopName, undefined, "package.json must not have a 'desktopName' field");

		const deps = pkg.dependencies ?? {};
		const devDeps = pkg.devDependencies ?? {};

		for (const forbidden of ["electron", "electron-builder", "electron-updater"]) {
			assert.equal(forbidden in deps, false, `dependencies must not include ${forbidden}`);
			assert.equal(forbidden in devDeps, false, `devDependencies must not include ${forbidden}`);
		}
	});
});
