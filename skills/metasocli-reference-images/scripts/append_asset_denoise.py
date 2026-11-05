#!/usr/bin/env python3
"""Local, deterministic preparation of NEW recipes; never executes image requests."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

# Reuse the existing handoff normalization, IDs and JSON validation.
_spec = importlib.util.spec_from_file_location("denoise_handoff", Path(__file__).with_name("validate_handoff.py"))
assert _spec and _spec.loader
handoff = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(handoff)
ValidationError = handoff.ValidationError
ENTRIES = {"metasoclitk", "metasocli-video-prompts", "metasocli-video-prompts-旁白"}
KINDS = ("character", "scene", "prop")
UNTOUCHED = {"first_frame", "narration"}
POLICY_DIR = Path(__file__).resolve().parent.parent / "references/denoise"


def load_policy():
    manifest = handoff.load_json(POLICY_DIR / "manifest.json")
    if (manifest.get("schemaVersion") != 1 or manifest.get("policyVersion") != "user-verbatim-by-kind-v1"
            or manifest.get("encoding") != "UTF-8 without BOM" or manifest.get("lineEndings") != "LF"
            or manifest.get("terminalNewline") is not True):
        raise ValidationError("invalid packaged denoise manifest")
    entries = manifest.get("entries")
    if not isinstance(entries, list) or [e.get("kind") for e in entries] != list(KINDS):
        raise ValidationError("denoise manifest must map character, scene, prop exactly")
    texts = {}
    for item in entries:
        kind = item["kind"]
        if item.get("file") != f"{kind}.txt":
            raise ValidationError(f"invalid denoise file mapping: {kind}")
        raw = (POLICY_DIR / item["file"]).read_bytes()
        text = raw.decode("utf-8")
        if (raw.startswith(b"\xef\xbb\xbf") or b"\r" in raw or not raw.endswith(b"\n")
                or raw.endswith(b"\n\n") or hashlib.sha256(raw).hexdigest() != item.get("sha256")
                or len(raw) != item.get("bytes") or utf16_units(text) != item.get("utf16Units")):
            raise ValidationError(f"packaged denoise text/hash mismatch: {kind}")
        texts[kind] = text
    return manifest, texts


def utf16_units(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def normalized(text: str) -> str:
    handoff.require_string(text, "prompt")
    return handoff.normalize_prompt(text).decode("utf-8")


def _compose(prompt: str, kind: str, texts: dict[str, str]) -> tuple[str, str]:
    text = normalized(prompt)
    if kind in UNTOUCHED:
        # No image policy on audio/first frames, including their original whitespace.
        base, final = prompt, prompt
    elif kind not in KINDS:
        raise ValidationError(f"unsupported kind: {kind}")
    else:
        counts = {k: text.count(t[:-1]) for k, t in texts.items()}
        if any(counts[k] for k in KINDS if k != kind):
            raise ValidationError(f"{kind}: contains a different kind's complete denoise text")
        if counts[kind] > 1:
            raise ValidationError(f"{kind}: duplicate complete denoise text")
        if counts[kind] == 1:
            start = text.index(texts[kind][:-1])
            after = text[start + len(texts[kind]) - 1:]
            if after.strip("\n") or not text[:start].endswith("\n\n"):
                raise ValidationError(f"{kind}: denoise text must be at the end after two newlines")
            base = text[:start - 2]
            handoff.require_string(base, "basePrompt")
            final = text[:start] + texts[kind]
        else:
            base, final = text, text + "\n\n" + texts[kind]
    if utf16_units(normalized(final)) > 32000:
        raise ValidationError(f"{kind}: final prompt exceeds 32000 UTF-16 units; keep the full recipe, do not truncate")
    return base, final


def compose_prompt(base_prompt: str, kind: str) -> str:
    """Append the exact applicable text, or validate/reuse one existing final tail."""
    return _compose(base_prompt, kind, load_policy()[1])[1]


def assert_final_prompt(final_prompt: str, kind: str) -> None:
    texts = load_policy()[1]
    _, expected = _compose(final_prompt, kind, texts)
    # Only BOM/line-ending and EOF-LF normalization is allowed for an existing tail.
    if kind in KINDS and normalized(final_prompt).rstrip("\n") != expected.rstrip("\n"):
        raise ValidationError(f"{kind}: missing the complete final denoise text")


def _header(value, final: bool):
    handoff.require_object(value, "batch")
    handoff.require_exact_keys(value, {"schemaVersion", "entrySkill", "items"} | ({"policyVersion"} if final else set()), "batch")
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1 or value["entrySkill"] not in ENTRIES:
        raise ValidationError("schemaVersion must be 1 and entrySkill must be one of the three enabled entries")
    if not isinstance(value["items"], list) or len(value["items"]) > handoff.MAX_ASSETS:
        raise ValidationError("items must be an array of at most 2000 NEW recipes")
    seen = set()
    for item in value["items"]:
        handoff.require_object(item, "item")
        asset_id = handoff.validate_stable_id(item.get("assetId"), "assetId")
        if asset_id in seen:
            raise ValidationError(f"{asset_id}: duplicate assetId")
        seen.add(asset_id)


def compose_batch(value):
    if isinstance(value, dict) and "policyVersion" in value:
        check_batch(value)
        return value  # Repeat on the helper's own output never appends again.
    _header(value, False)
    manifest, texts = load_policy()
    result = {"schemaVersion": 1, "entrySkill": value["entrySkill"], "policyVersion": manifest["policyVersion"], "items": []}
    for item in value["items"]:
        asset_id = item["assetId"]
        try:
            handoff.require_exact_keys(item, {"assetId", "kind", "prompt"}, "new recipe")
            kind = handoff.require_string(item["kind"], "kind")
            base, final = _compose(item["prompt"], kind, texts)
            result["items"].append({"assetId": asset_id, "kind": kind, "basePrompt": base, "prompt": final,
                "recipeSha256": hashlib.sha256(handoff.normalize_prompt(final)).hexdigest(),
                "denoise": {"applied": kind in KINDS, "textSha256": hashlib.sha256(texts[kind].encode("utf-8")).hexdigest() if kind in KINDS else None}})
        except (ValidationError, UnicodeError) as error:
            raise ValidationError(f"{asset_id}: {error}") from error
    return result


def check_batch(value) -> None:
    _header(value, True)
    manifest, texts = load_policy()
    if value["policyVersion"] != manifest["policyVersion"]:
        raise ValidationError("policyVersion does not match packaged texts")
    for item in value["items"]:
        asset_id = item["assetId"]
        try:
            handoff.require_exact_keys(item, {"assetId", "kind", "basePrompt", "prompt", "recipeSha256", "denoise"}, "final recipe")
            kind = handoff.require_string(item["kind"], "kind")
            base, final = _compose(item["basePrompt"], kind, texts)
            if base != item["basePrompt"] or final != item["prompt"]:
                raise ValidationError("base/final text mismatch; preserve the complete base and final tail")
            expected = {"applied": kind in KINDS, "textSha256": hashlib.sha256(texts[kind].encode("utf-8")).hexdigest() if kind in KINDS else None}
            if item["denoise"] != expected or item["recipeSha256"] != hashlib.sha256(handoff.normalize_prompt(final)).hexdigest():
                raise ValidationError("final prompt SHA-256 or denoise evidence mismatch")
        except (ValidationError, UnicodeError) as error:
            raise ValidationError(f"{asset_id}: {error}") from error


def save_new_output(source: Path, output: Path, value) -> None:
    if source.resolve() == output.resolve():
        raise ValidationError("output must be a new preparation file, never the input")
    # Refuse aliases; never follow a linked output into an existing record.
    for part in (output, *output.parents):
        if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
            raise ValidationError("output must not traverse a link or junction")
    raw = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    try:
        with output.open("xb") as handle:
            handle.write(raw)
    except FileExistsError:
        if not output.is_file() or output.stat().st_nlink != 1 or output.read_bytes() != raw:
            raise ValidationError("output exists with different content; choose a NEW preparation file, no overwrite")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    compose = commands.add_parser("compose")
    compose.add_argument("--input", type=Path, required=True)
    compose.add_argument("--output", type=Path, required=True)
    check = commands.add_parser("check")
    check.add_argument("--input", type=Path, required=True)
    args = parser.parse_args()
    try:
        # Auxiliary output keeps both base and final text, unlike a single handoff.
        value = json.loads(args.input.read_bytes().decode("utf-8-sig"), object_pairs_hook=handoff.reject_duplicate_pairs)
        if args.command == "compose":
            value = compose_batch(value)
            check_batch(value)
            save_new_output(args.input, args.output, value)
        else:
            check_batch(value)
        print("VALID")
        return 0
    except (ValidationError, OSError, UnicodeError, TypeError, KeyError, json.JSONDecodeError) as error:
        print(f"DENOISE_PREPARATION_INVALID: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
