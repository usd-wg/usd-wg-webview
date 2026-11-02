# Radix release packaging

`radix-0.0.1-portable.tgz` is the MIT-licensed published `@sparkjsdev/radix`
0.0.1 release. Its JavaScript, declarations, and license are unchanged.
The sole patch moves `fsevents` from required to optional dependencies:
upstream incorrectly requires this macOS-only development dependency on Linux
and Windows as well.

Reproduce from the repository root on Linux/WSL (Node 22 and GNU tar):

```sh
node tools/vendor-radix.mjs
```

The script verifies the original npm SHA-512 before repacking. The lockfile
also checks the patched archive. Use the normal registry dependency once an
upstream release fixes the manifest.
