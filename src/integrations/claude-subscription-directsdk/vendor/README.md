# Bundled Claude DirectSDK transport

This directory vendors the Claude subscription transport from [NousResearch/hermes-plugin-claude-subscription-directsdk](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk), version `0.3.0`, under the included MIT license.

LUMI bundles the transport modules it needs (`directsdk.py`, `admission.py`, `directsdk_setup.py`, `inert_mcp.py`, and `model_catalog.py`) with the plugin manifest used by the local bridge. The adapter is adjusted to use LUMI's tool namespace and user-facing setup messages. Hermes core is not required or bundled.

When updating this snapshot, review upstream changes to request admission, cancellation, authentication isolation, model routing, and replay handling. Update this note and rerun the LUMI provider checks with the same change.
