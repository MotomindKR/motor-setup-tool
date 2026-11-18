# Motomind UI

`motomindkr-ui-4.1.0.tgz` is the built `@motomindkr/ui` package from
[MotomindKR/design-guidelines](https://github.com/MotomindKR/design-guidelines),
commit `145b810`. The package includes its README and third-party notices.

This pinned, local package is the tarball consumption method supported by the
design system. It lets desktop contributors and release CI install the UI
without GitHub Packages credentials or a sibling checkout. The package remains
internal, under its original `UNLICENSED` terms.

To update, download a release tarball or run `npm pack --workspace @motomindkr/ui`
in the design-guidelines checkout, put the resulting tarball here, update the
dependency in `../package.json`, and run `npm install`, `npm run check`, and
`npm run test:ui` from `electron/`.
