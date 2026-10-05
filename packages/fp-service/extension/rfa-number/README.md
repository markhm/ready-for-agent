# rfa-number fp extension

The harness gives each fp Issue it works a number and keeps it in fp, in an
Issue property called `rfa-number` ([ADR 0074](../../../../docs/adr/0074-fp-issues-carry-a-harness-number-in-fp.md)).
fp only accepts a property an extension registers, so this extension must be
installed wherever the harness reads and writes fp Issues.

## Install

On the machine that runs the harness, as the user that runs it:

```sh
mkdir -p ~/.fiberplane/extensions
cp -R packages/fp-service/extension/rfa-number ~/.fiberplane/extensions/
```

A global extension applies to every fp project on that machine. To check a
project, run `fp guide` in its folder: the project context must list
`rfa-number (text)` under "Other registered properties". The fp project in
the harness's Repository settings reports "not ready" until it does.

Without the extension, fp refuses to write the property; numbers already
stored stay readable from the fp CLI. Whether fp sync carries the property
to other machines, and how the fp app shows it there, has not been checked.

## What it accepts

A positive integer, or empty (fp clears a property by writing it empty, and
an empty value counts as no number). The harness writes the numbers; correct
or clear one by hand only to resolve a duplicate the harness reports.
