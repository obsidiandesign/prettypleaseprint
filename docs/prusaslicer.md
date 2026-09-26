# Open in PrusaSlicer (removed)

[← back to the README](../README.md)

This page described a one-click bridge that handed an uploaded model to
PrusaSlicer on the printer owner's machine: a `ppp://` link carrying a
short-lived credential, and a small helper that fetched the file.

It was removed in September 2026, when requests stopped being uploaded files
and became MakerWorld links sliced by Bambuddy. There is no file on the app
side to hand to a slicer any more, and slicing happens in Bambuddy's Slicer
Pipeline instead. See
[Intake: a link, handed to Bambuddy](architecture.md#intake-a-link-handed-to-bambuddy).

If you installed the helper on Linux, it can be removed:

```bash
rm ~/.local/share/applications/ppp-slicer.desktop
sed -i '/x-scheme-handler\/ppp=/d' ~/.config/mimeapps.list
rm -rf ~/.config/ppp "${XDG_STATE_HOME:-$HOME/.local/state}/ppp"
```
