import { cp, mkdir, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"

const root = process.cwd()
const short = "AuraPro"
const packageRoot = path.join(root, ".theme-package")
const themeRoot = path.join(packageRoot, short)
const output = path.join(root, "theme.tar.gz")

if (!themeRoot.startsWith(`${root}${path.sep}`)) throw new Error("invalid package path")

await rm(packageRoot, { recursive: true, force: true })
await mkdir(themeRoot, { recursive: true })
await cp(path.join(root, "theme.json"), path.join(themeRoot, "theme.json"))
await cp(path.join(root, "preview.png"), path.join(themeRoot, "preview.png"))
await cp(path.join(root, "dist"), path.join(themeRoot, "dist"), { recursive: true })

const result = spawnSync("tar", ["-czf", output, "-C", themeRoot, "."], {
  stdio: "inherit",
})
if (result.status !== 0) process.exit(result.status ?? 1)

await rm(packageRoot, { recursive: true, force: true })
console.log(`Created ${output}`)
