# Releasing

## Cutting a release

1. Bump `<revision>` in the root `pom.xml`.
2. Update `version` in `oie.json` to match. The build fails if it doesn't.
3. `mvn clean package` and confirm the test count in the output. A green exit
   code alone doesn't mean the suite ran.
4. Commit, tag `v<version>`, push the tag.
5. CI builds the tag and stages a **draft** release. Review its assets, then
   publish by hand.

## Rules

**Releases are cut from a pushed version tag, never from a push to the default
branch.** A release step gated on branch pushes re-fires on every merge and
silently overwrites a published release's assets with newer builds.

**The tag must equal the version in the tree.** Three places carry it and they
are chained: the release workflow checks the pushed tag against `oie.json`, and
the package module's own check ties `oie.json` to the pom's `<revision>`. Break
any link and the release fails.

Nothing overrides the pom at build time, deliberately. Passing `-Drevision=` from
the tag would make CI produce a different version than a developer building the
same commit locally, and would leave the pom's `<revision>` unchecked.

**A human publishes.** Never auto-publish. Build the draft, look at it, then
publish.

**Never overwrite a published release's assets.** They're immutable. If the
build is wrong, cut a new version.

**Leave old releases' assets alone.** Users download specific versions. Only
remove an asset that's actually wrong, never as routine cleanup.

**Credit external PR submitters** in the notes, in a Thanks section. External
contributors only.

## Bumping during development

Bump the version on every rebuild handed over for manual installation, even
mid-development. Two different builds must never exist under one version number:
an installed artifact has to be able to say which build it is, or "did the
install actually take?" becomes unanswerable.

A patch increment is all that is wanted here. The bump exists so the engine and
the Extensions page pick up a different build, not to describe the change, so
2.6.1, 2.6.2 and so on through a working session. Save the minor and major
digits for an actual release, where they mean something to whoever installs it.

The version is declared in one place, the pom's `<revision>`. `plugin.xml` and
`webadmin/plugin.json` are filtered from it at package time; `oie.json` is
checked against it at build time because the extension store reads it from the
repo root.
