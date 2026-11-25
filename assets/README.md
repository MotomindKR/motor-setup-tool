# Brand assets

| Asset | Source and use |
|---|---|
| `motomind-logo.svg` | [Official Motomind artwork](https://www.motomind.co.kr/src/motomind_logo.svg), downloaded 2026-09-22; original red preserved |
| `motor-setup-tool.svg` | App icon derived from the wordmark's M outline, with a motor face, zero mark, and scale ticks |
| `icons/*.png` | 16–512 px launcher icons; Electron uses the 256 px version |
| `fonts/Pretendard-{Regular,SemiBold,Bold}.otf` | [Pretendard static fonts](https://github.com/orioncactus/pretendard/tree/main/packages/pretendard/dist/public/static), redistributed under [SIL OFL](fonts/OFL.txt) |

The logo and icon were optimized with SVGO 4 (`--multipass`). Regenerate PNGs
with `python3 assets/build_icons.py` (`python3-gi` and `librsvg2-common` needed).
Vite bundles the frontend fonts and artwork. The desktop package includes
launcher icons and license notices. Motomind retains its trademark.

The MILLY viewer uses `milly/MILLY.urdf` and a ZIP of the nine visual STL
files from [Milly SDK release 1.1.4](https://github.com/MotomindKR/motomind_milly_sdk_release/tree/b46399c854a0239a591eca6143fb57493895969c/milly_description).
The source meshes are stored unchanged in ZIP entries named by basename.
`milly/teaching-profile.json` matches the right-hand device profile in the
release's Teaching SDK wheel (0.1.3) and [platform source](https://github.com/MotomindKR/motomind_platform/blob/0b847b3ed39eda6a6c41c3b2ff6f728379b6affa/platform/python/motomind_teaching_sdk/src/motomind_teaching/_right_device.json).
See the [model license](milly/LICENSE).
