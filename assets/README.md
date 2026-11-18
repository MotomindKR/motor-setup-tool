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
