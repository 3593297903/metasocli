#!/usr/bin/env python3
"""Validate metasocli image handoffs and import-draft bindings using only the standard library."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import uuid
from pathlib import Path
from typing import Any

MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_ASSETS = 2000
STABLE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
EPISODE_ID = STABLE_ID
SHA256 = re.compile(r"^[a-f0-9]{64}$")
WINDOWS_DEVICE = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$", re.IGNORECASE)
CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")
KINDS = {"character", "scene", "prop", "first_frame"}
STATUSES = {"generated", "reused", "skipped_optional", "blocked", "failed"}
MODES = {"built_in", "not_run"}
PLACEHOLDERS = ("同上", "见前文", "见上文", "沿用前面", "待补充", "tbd", "todo")

REQUEST_TOP_KEYS = {"schemaVersion", "episodeId", "modelPreference", "requireExactModel", "assets"}
REQUEST_ASSET_KEYS = {
    "assetId",
    "version",
    "order",
    "kind",
    "name",
    "required",
    "requiredBySegments",
    "visualDescription",
    "sourceFacts",
    "continuityRequirements",
    "exclude",
    "dependencyAssetIds",
    "exactText",
}
RECIPE_TOP_KEYS = {"schemaVersion", "episodeId", "assets"}
RECIPE_ASSET_KEYS = {
    "assetId",
    "kind",
    "status",
    "generationPrompt",
    "recipeSha256",
    "existingRelativePath",
    "contentSha256",
    "reason",
}
RECIPE_STATUSES = {"planned", "reused", "skipped_optional", "blocked"}
RESULT_TOP_KEYS = {"schemaVersion", "episodeId", "assets"}
RESULT_ASSET_KEYS = {
    "assetId",
    "kind",
    "status",
    "operationId",
    "stagedRelativePath",
    "existingRelativePath",
    "contentSha256",
    "generationPrompt",
    "recipeSha256",
    "generationMode",
    "reportedModel",
    "reason",
}
class ValidationError(Exception):
    pass


def reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValidationError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(path: Path) -> Any:
    raw = path.read_bytes()
    if len(raw) > MAX_JSON_BYTES:
        raise ValidationError(f"JSON exceeds {MAX_JSON_BYTES} bytes: {path}")
    try:
        return json.loads(raw.decode("utf-8-sig"), object_pairs_hook=reject_duplicate_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(f"invalid UTF-8 JSON: {path}: {error}") from error


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{label} must be an object")
    return value


def require_exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise ValidationError(f"{label} keys differ; missing={missing}, extra={extra}")


def require_string(value: Any, label: str, *, nullable: bool = False, maximum: int = 1_048_576) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValidationError(f"{label} must be a non-empty string up to {maximum} characters")
    return value


def require_string_list(value: Any, label: str, *, allow_empty: bool = True) -> list[str]:
    if not isinstance(value, list) or (not allow_empty and not value):
        raise ValidationError(f"{label} must be a{' non-empty' if not allow_empty else ''} string array")
    if not all(isinstance(item, str) and item and len(item) <= 8192 for item in value):
        raise ValidationError(f"{label} contains an invalid string")
    if len(set(value)) != len(value):
        raise ValidationError(f"{label} contains duplicates")
    return value


def validate_stable_id(value: Any, label: str, *, episode: bool = False) -> str:
    text = require_string(value, label, maximum=80)
    assert text is not None
    pattern = EPISODE_ID if episode else STABLE_ID
    if pattern.fullmatch(text) is None or re.fullmatch(r"con|prn|aux|nul|com[0-9]|lpt[0-9]", text):
        raise ValidationError(f"{label} is not a portable stable ID")
    return text


def validate_request(raw: Any) -> dict[str, Any]:
    request = require_object(raw, "request")
    require_exact_keys(request, REQUEST_TOP_KEYS, "request")
    if request["schemaVersion"] != "1.0.0":
        raise ValidationError("request.schemaVersion must be 1.0.0")
    validate_stable_id(request["episodeId"], "request.episodeId", episode=True)
    if request["modelPreference"] is not None:
        require_string(request["modelPreference"], "request.modelPreference", maximum=100)
    if not isinstance(request["requireExactModel"], bool):
        raise ValidationError("request.requireExactModel must be a boolean")
    if request["requireExactModel"]:
        raise ValidationError(
            "EXACT_MODEL_UNVERIFIABLE: the current image execution contract has no trusted exact-model evidence"
        )
    assets = request["assets"]
    if not isinstance(assets, list) or len(assets) > MAX_ASSETS:
        raise ValidationError(f"request.assets must be an array of at most {MAX_ASSETS} items")

    seen_ids: set[str] = set()
    seen_orders: set[int] = set()
    previous_order = 0
    for index, raw_asset in enumerate(assets):
        label = f"request.assets[{index}]"
        asset = require_object(raw_asset, label)
        require_exact_keys(asset, REQUEST_ASSET_KEYS, label)
        asset_id = validate_stable_id(asset["assetId"], f"{label}.assetId")
        if asset_id in seen_ids:
            raise ValidationError(f"duplicate assetId: {asset_id}")
        require_string(asset["version"], f"{label}.version", maximum=100)
        order = asset["order"]
        if isinstance(order, bool) or not isinstance(order, int) or order <= 0 or order in seen_orders:
            raise ValidationError(f"{label}.order must be a unique positive integer")
        if order <= previous_order:
            raise ValidationError(f"{label}.order must increase in request array order")
        kind = asset["kind"]
        if not isinstance(kind, str) or kind not in KINDS:
            raise ValidationError(f"{label}.kind is unsupported")
        require_string(asset["name"], f"{label}.name", maximum=500)
        if not isinstance(asset["required"], bool):
            raise ValidationError(f"{label}.required must be a boolean")
        segments = require_string_list(asset["requiredBySegments"], f"{label}.requiredBySegments", allow_empty=not asset["required"])
        for segment in segments:
            validate_stable_id(segment, f"{label}.requiredBySegments item")
        description = require_string(asset["visualDescription"], f"{label}.visualDescription")
        assert description is not None
        folded = description.casefold()
        if any(placeholder.casefold() in folded for placeholder in PLACEHOLDERS):
            raise ValidationError(f"{label}.visualDescription contains a forbidden placeholder")
        require_string_list(asset["sourceFacts"], f"{label}.sourceFacts")
        require_string_list(asset["continuityRequirements"], f"{label}.continuityRequirements")
        require_string_list(asset["exclude"], f"{label}.exclude")
        dependencies = require_string_list(asset["dependencyAssetIds"], f"{label}.dependencyAssetIds")
        for dependency in dependencies:
            validate_stable_id(dependency, f"{label}.dependencyAssetIds item")
            if dependency == asset_id:
                raise ValidationError(f"{label} depends on itself")
            if dependency not in seen_ids:
                raise ValidationError(f"{label} dependency must refer to an earlier request asset: {dependency}")
        require_string_list(asset["exactText"], f"{label}.exactText")
        seen_ids.add(asset_id)
        seen_orders.add(order)
        previous_order = order
    return request


def validate_recipe(raw: Any, request: dict[str, Any]) -> dict[str, Any]:
    recipe = require_object(raw, "recipe")
    require_exact_keys(recipe, RECIPE_TOP_KEYS, "recipe")
    if recipe["schemaVersion"] != "1.0.0":
        raise ValidationError("recipe.schemaVersion must be 1.0.0")
    if recipe["episodeId"] != request["episodeId"]:
        raise ValidationError("recipe.episodeId does not match request")
    assets = recipe["assets"]
    if not isinstance(assets, list) or len(assets) != len(request["assets"]):
        raise ValidationError("recipe.assets must contain one item for every request asset")
    for index, (raw_recipe, request_asset) in enumerate(zip(assets, request["assets"], strict=True)):
        label = f"recipe.assets[{index}]"
        item = require_object(raw_recipe, label)
        require_exact_keys(item, RECIPE_ASSET_KEYS, label)
        if item["assetId"] != request_asset["assetId"] or item["kind"] != request_asset["kind"]:
            raise ValidationError(f"{label} identity does not match the request at the same position")
        status = item["status"]
        if not isinstance(status, str) or status not in RECIPE_STATUSES:
            raise ValidationError(f"{label}.status is unsupported")
        prompt = require_string(item["generationPrompt"], f"{label}.generationPrompt", nullable=True)
        recipe_hash = validate_sha(item["recipeSha256"], f"{label}.recipeSha256")
        existing = validate_relative_path(item["existingRelativePath"], f"{label}.existingRelativePath")
        content_hash = validate_sha(item["contentSha256"], f"{label}.contentSha256")
        reason = require_string(item["reason"], f"{label}.reason", nullable=True, maximum=8192)
        if status == "planned":
            if not request_asset["required"] or prompt is None or recipe_hash is None:
                raise ValidationError(f"{label}.planned requires a required request and complete recipe")
            if hashlib.sha256(normalize_prompt(prompt)).hexdigest() != recipe_hash:
                raise ValidationError(f"{label}.recipeSha256 does not match generationPrompt")
            if len(normalize_prompt(prompt).decode("utf-8").encode("utf-16-le")) // 2 > 32000:
                raise ValidationError(f"{label}.generationPrompt exceeds the metasocli recipe limit")
            if any(value is not None for value in (existing, content_hash, reason)):
                raise ValidationError(f"{label}.planned fields are inconsistent")
        elif status == "reused":
            if existing is None or content_hash is None or any(value is not None for value in (prompt, recipe_hash, reason)):
                raise ValidationError(f"{label}.reused fields are inconsistent")
        elif status == "skipped_optional":
            if request_asset["required"] or any(value is not None for value in (prompt, recipe_hash, existing, content_hash, reason)):
                raise ValidationError(f"{label}.skipped_optional fields are inconsistent")
        elif reason is None or any(value is not None for value in (prompt, recipe_hash, existing, content_hash)):
            raise ValidationError(f"{label}.blocked fields are inconsistent")
    return recipe


def validate_import_draft(raw: Any, request: dict[str, Any], recipe: dict[str, Any] | None = None) -> None:
    """Check allocation and exact image recipe transfer; the CLI validates the full import schema."""
    draft = require_object(raw, "draft")
    if draft.get("episodeId") != request["episodeId"]:
        raise ValidationError("draft.episodeId does not match request")
    segments = draft.get("segments")
    if not isinstance(segments, list) or not segments:
        raise ValidationError("draft.segments must be a non-empty array")
    requested = {item["assetId"]: item for item in request["assets"]}
    used_by: dict[str, set[str]] = {asset_id: set() for asset_id in requested}
    segment_ids: set[str] = set()
    for index, raw_segment in enumerate(segments):
        segment = require_object(raw_segment, f"draft.segments[{index}]")
        segment_id = validate_stable_id(segment.get("id"), "draft segment ID")
        if segment_id in segment_ids:
            raise ValidationError("draft contains duplicate segment IDs")
        segment_ids.add(segment_id)
        references = segment.get("references", [])
        if not isinstance(references, list) or len(references) > 9:
            raise ValidationError("draft references must be an array of at most nine images")
        seen: set[str] = set()
        for raw_reference in references:
            reference = require_object(raw_reference, "draft image reference")
            asset_id = validate_stable_id(reference.get("assetId"), "draft reference assetId")
            if asset_id not in requested or asset_id in seen:
                raise ValidationError(f"draft image reference is missing from request or duplicated: {asset_id}")
            seen.add(asset_id)
            expected_role = "first_frame" if requested[asset_id]["kind"] == "first_frame" else "reference_image"
            if reference.get("role") != expected_role:
                raise ValidationError(f"draft reference role differs from asset kind: {asset_id}")
            if expected_role == "first_frame" and (len(references) != 1 or segment.get("narration") is not None):
                raise ValidationError("a first frame cannot be combined with reference images or narration")
            used_by[asset_id].add(segment_id)
    # The request validator enforces dependency-before-dependant order.
    for item in reversed(request["assets"]):
        for dependency in item["dependencyAssetIds"]:
            used_by[dependency].update(used_by[item["assetId"]])
    for item in request["assets"]:
        asset_id = item["assetId"]
        expected = used_by[asset_id]
        if set(item["requiredBySegments"]) != expected or item["required"] != bool(expected):
            raise ValidationError(f"requiredBySegments/required differs from draft use or dependencies: {asset_id}")
    if recipe is None:
        return
    raw_recipes = draft.get("recipes", [])
    if not isinstance(raw_recipes, list):
        raise ValidationError("draft.recipes must be an array")
    imported: dict[str, dict[str, Any]] = {}
    for index, raw_item in enumerate(raw_recipes):
        item = require_object(raw_item, f"draft.recipes[{index}]")
        asset_id = validate_stable_id(item.get("assetId"), "draft recipe assetId")
        if asset_id in imported:
            raise ValidationError(f"duplicate draft recipe: {asset_id}")
        imported[asset_id] = item
        if item.get("kind") == "narration":
            if asset_id in requested:
                raise ValidationError("narration cannot replace an image recipe")
            continue
        if asset_id not in requested:
            raise ValidationError(f"draft image recipe is absent from the image request: {asset_id}")
    for planned, source in zip(recipe["assets"], request["assets"], strict=True):
        asset_id = source["assetId"]
        item = imported.get(asset_id)
        if planned["status"] == "planned" and item is None:
            raise ValidationError(f"planned recipe missing from import draft: {asset_id}")
        if item is None:
            continue  # Reused assets can already exist in the current story.
        if planned["status"] not in {"planned", "reused"}:
            raise ValidationError(f"draft must not introduce a blocked/optional recipe: {asset_id}")
        if item.get("kind") != source["kind"]:
            raise ValidationError(f"draft recipe kind differs from request: {asset_id}")
        if item.get("dependencies", []) != source["dependencyAssetIds"] or item.get("exactText", []) != source["exactText"]:
            raise ValidationError(f"draft recipe dependencies or exactText changed: {asset_id}")
        if planned["status"] == "planned":
            prompt = require_string(item.get("prompt"), "draft recipe prompt")
            assert prompt is not None
            if normalize_prompt(prompt) != normalize_prompt(planned["generationPrompt"]):
                raise ValidationError(f"draft shortened or changed the complete planned prompt: {asset_id}")


def normalize_prompt(text: str) -> bytes:
    if text.startswith("\ufeff"):
        text = text[1:]
    return text.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")


def validate_relative_path(value: Any, label: str, *, nullable: bool = True) -> str | None:
    text = require_string(value, label, nullable=nullable, maximum=1024)
    if text is None:
        return None
    if CONTROL_CHARACTER.search(text) or "\\" in text or text.startswith("/") or re.match(r"^[A-Za-z]:", text):
        raise ValidationError(f"{label} must be a portable project-relative path using /")
    if ":" in text:
        raise ValidationError(f"{label} contains an alternate-data-stream or URI-like colon")
    parts = text.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise ValidationError(f"{label} contains an unsafe path component")
    if any(part.endswith((".", " ")) or WINDOWS_DEVICE.fullmatch(part) for part in parts):
        raise ValidationError(f"{label} contains a Windows-ambiguous path component")
    return text


def parse_uuid(value: Any, label: str, *, nullable: bool = True) -> str | None:
    text = require_string(value, label, nullable=nullable, maximum=100)
    if text is None:
        return None
    try:
        parsed = uuid.UUID(text)
    except ValueError as error:
        raise ValidationError(f"{label} must be a UUID") from error
    if str(parsed) != text.lower():
        raise ValidationError(f"{label} must use canonical lowercase UUID form")
    return text


def validate_sha(value: Any, label: str, *, nullable: bool = True) -> str | None:
    text = require_string(value, label, nullable=nullable, maximum=64)
    if text is not None and SHA256.fullmatch(text) is None:
        raise ValidationError(f"{label} must be a lowercase SHA-256")
    return text


def validate_result(raw: Any, request: dict[str, Any], recipe: dict[str, Any], project_root: Path | None) -> dict[str, Any]:
    result = require_object(raw, "result")
    require_exact_keys(result, RESULT_TOP_KEYS, "result")
    if result["schemaVersion"] != "1.0.0":
        raise ValidationError("result.schemaVersion must be 1.0.0")
    if result["episodeId"] != request["episodeId"]:
        raise ValidationError("result.episodeId does not match request")
    assets = result["assets"]
    if not isinstance(assets, list) or len(assets) != len(request["assets"]):
        raise ValidationError("result.assets must contain one item for every request asset")

    for index, (raw_result, request_asset, recipe_asset) in enumerate(zip(assets, request["assets"], recipe["assets"], strict=True)):
        label = f"result.assets[{index}]"
        item = require_object(raw_result, label)
        require_exact_keys(item, RESULT_ASSET_KEYS, label)
        if item["assetId"] != request_asset["assetId"] or item["kind"] != request_asset["kind"]:
            raise ValidationError(f"{label} identity does not match the request at the same position")
        status = item["status"]
        if not isinstance(status, str) or status not in STATUSES:
            raise ValidationError(f"{label}.status is unsupported")
        operation_id = parse_uuid(item["operationId"], f"{label}.operationId")
        staged = validate_relative_path(item["stagedRelativePath"], f"{label}.stagedRelativePath")
        existing = validate_relative_path(item["existingRelativePath"], f"{label}.existingRelativePath")
        content_hash = validate_sha(item["contentSha256"], f"{label}.contentSha256")
        prompt = require_string(item["generationPrompt"], f"{label}.generationPrompt", nullable=True)
        recipe_hash = validate_sha(item["recipeSha256"], f"{label}.recipeSha256")
        mode = item["generationMode"]
        if not isinstance(mode, str) or mode not in MODES:
            raise ValidationError(f"{label}.generationMode is unsupported")
        reported_model = require_string(item["reportedModel"], f"{label}.reportedModel", nullable=True, maximum=100)
        reason = require_string(item["reason"], f"{label}.reason", nullable=True, maximum=8192)

        if status == "generated":
            if recipe_asset["status"] != "planned":
                raise ValidationError(f"{label} can only generate a planned recipe")
            if not request_asset["required"]:
                raise ValidationError(f"{label} cannot generate an optional request")
            if None in {operation_id, staged, content_hash, prompt, recipe_hash} or existing is not None:
                raise ValidationError(f"{label} generated fields are incomplete")
            expected_prefix = f".metasocli/drafts/assets/{operation_id}/"
            if not staged.startswith(expected_prefix):
                raise ValidationError(f"{label}.stagedRelativePath is outside its operation directory")
            assert prompt is not None and recipe_hash is not None
            if hashlib.sha256(normalize_prompt(prompt)).hexdigest() != recipe_hash:
                raise ValidationError(f"{label}.recipeSha256 does not match generationPrompt")
            if normalize_prompt(prompt) != normalize_prompt(recipe_asset["generationPrompt"]) or recipe_hash != recipe_asset["recipeSha256"]:
                raise ValidationError(f"{label} changed the planned generation recipe")
            if mode != "built_in" or reason is not None:
                raise ValidationError(f"{label} generated execution metadata is inconsistent")
        elif status == "reused":
            if recipe_asset["status"] != "reused":
                raise ValidationError(f"{label} does not preserve the recipe reuse decision")
            if existing is None or content_hash is None or any(value is not None for value in (operation_id, staged)):
                raise ValidationError(f"{label} reused fields are incomplete")
            if mode != "not_run" or reason is not None or reported_model is not None:
                raise ValidationError(f"{label} reused execution metadata is inconsistent")
            if existing != recipe_asset["existingRelativePath"] or content_hash != recipe_asset["contentSha256"]:
                raise ValidationError(f"{label} substituted a different reused file")
            if prompt is not None or recipe_hash is not None:
                raise ValidationError(f"{label} reused result must not claim a new generation recipe")
        elif status == "skipped_optional":
            if recipe_asset["status"] != "skipped_optional":
                raise ValidationError(f"{label} does not preserve the optional skip decision")
            if request_asset["required"]:
                raise ValidationError(f"{label} cannot skip a required request as optional")
            if any(value is not None for value in (operation_id, staged, existing, content_hash, prompt, recipe_hash, reported_model, reason)) or mode != "not_run":
                raise ValidationError(f"{label} skipped_optional fields are inconsistent")
        else:
            if reason is None:
                raise ValidationError(f"{label}.{status} requires a reason")
            if any(value is not None for value in (operation_id, staged, existing, content_hash, prompt, recipe_hash, reported_model)):
                raise ValidationError(f"{label}.{status} must not claim an artifact")
            if status == "blocked" and mode != "not_run":
                raise ValidationError(f"{label}.blocked must use not_run")
            if status == "failed" and mode != "built_in":
                raise ValidationError(f"{label}.failed must report the attempted generation mode")
            if recipe_asset["status"] not in {"planned", "blocked"}:
                raise ValidationError(f"{label}.{status} is inconsistent with the recipe decision")

        path_to_check = staged if status == "generated" else existing if status == "reused" else None
        if project_root is not None and path_to_check is not None:
            target = resolve_project_file(project_root, path_to_check, f"{label} artifact")
            observed = hashlib.sha256(target.read_bytes()).hexdigest()
            if observed != content_hash:
                raise ValidationError(f"{label}.contentSha256 does not match the file")
    return result


def resolve_project_file(project_root: Path, relative_path: str, label: str) -> Path:
    root = project_root.resolve(strict=True)
    lexical = root / Path(*relative_path.split("/"))
    if lexical.is_symlink():
        raise ValidationError(f"{label} cannot be a symbolic link")
    target = lexical.resolve(strict=True)
    if target != root and root not in target.parents:
        raise ValidationError(f"{label} resolves outside project root")
    if not target.is_file():
        raise ValidationError(f"{label} is not a regular file")
    return target


def self_test() -> None:
    request = {
        "schemaVersion": "1.0.0",
        "episodeId": "episode-01",
        "modelPreference": None,
        "requireExactModel": False,
        "assets": [{
            "assetId": "lead-main",
            "version": "v1",
            "order": 1,
            "kind": "character",
            "name": "主角人物参考图",
            "required": True,
            "requiredBySegments": ["s01"],
            "visualDescription": "成年男性，固定深色外套，完整外观由上游锁定。",
            "sourceFacts": ["第1段出场"],
            "continuityRequirements": ["保持同一身份和服装"],
            "exclude": ["其他人物"],
            "dependencyAssetIds": [],
            "exactText": [],
        }],
    }
    validated_request = validate_request(request)
    prompt = "同一角色的专业人物三视图参考板。"
    recipe = {
        "schemaVersion": "1.0.0",
        "episodeId": "episode-01",
        "assets": [{
            "assetId": "lead-main",
            "kind": "character",
            "status": "planned",
            "generationPrompt": prompt,
            "recipeSha256": hashlib.sha256(normalize_prompt(prompt)).hexdigest(),
            "existingRelativePath": None,
            "contentSha256": None,
            "reason": None,
        }],
    }
    validated_recipe = validate_recipe(recipe, validated_request)
    operation_id = "00000000-0000-4000-8000-000000000001"
    relative = f".metasocli/drafts/assets/{operation_id}/lead.png"
    content_hash = hashlib.sha256(b"self-test-image").hexdigest()
    recipe_hash = hashlib.sha256(normalize_prompt(prompt)).hexdigest()
    result = {
        "schemaVersion": "1.0.0",
        "episodeId": "episode-01",
        "assets": [{
            "assetId": "lead-main",
            "kind": "character",
            "status": "generated",
            "operationId": operation_id,
            "stagedRelativePath": relative,
            "existingRelativePath": None,
            "contentSha256": content_hash,
            "generationPrompt": prompt,
            "recipeSha256": recipe_hash,
            "generationMode": "built_in",
            "reportedModel": None,
            "reason": None,
        }],
    }
    validate_result(result, validated_request, validated_recipe, None)
    invalid = json.loads(json.dumps(request))
    invalid["assets"][0]["visualDescription"] = "同上"
    try:
        validate_request(invalid)
    except ValidationError:
        pass
    else:
        raise ValidationError("self-test failed to reject a placeholder")
    exact = json.loads(json.dumps(request))
    exact["requireExactModel"] = True
    try:
        validate_request(exact)
    except ValidationError as error:
        if not str(error).startswith("EXACT_MODEL_UNVERIFIABLE:"):
            raise ValidationError("self-test received the wrong exact-model error") from error
    else:
        raise ValidationError("self-test failed to reject an unverifiable exact model")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    subparsers = parser.add_subparsers(dest="command")
    request_parser = subparsers.add_parser("request")
    request_parser.add_argument("path", type=Path)
    request_parser.add_argument("--draft", type=Path)
    recipe_parser = subparsers.add_parser("recipe")
    recipe_parser.add_argument("path", type=Path)
    recipe_parser.add_argument("--request", required=True, type=Path)
    recipe_parser.add_argument("--draft", type=Path)
    result_parser = subparsers.add_parser("result")
    result_parser.add_argument("path", type=Path)
    result_parser.add_argument("--request", required=True, type=Path)
    result_parser.add_argument("--recipe", required=True, type=Path)
    result_parser.add_argument("--project-root", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.self_test:
            self_test()
        elif args.command == "request":
            request = validate_request(load_json(args.path))
            if args.draft is not None:
                validate_import_draft(load_json(args.draft), request)
        elif args.command == "recipe":
            request = validate_request(load_json(args.request))
            recipe = validate_recipe(load_json(args.path), request)
            if args.draft is not None:
                validate_import_draft(load_json(args.draft), request, recipe)
        elif args.command == "result":
            request = validate_request(load_json(args.request))
            recipe = validate_recipe(load_json(args.recipe), request)
            validate_result(load_json(args.path), request, recipe, args.project_root)
        else:
            raise ValidationError("choose --self-test, request, recipe, or result")
    except (OSError, UnicodeError, ValidationError) as error:
        print(f"INVALID: {error}", file=sys.stderr)
        return 1
    print("VALID")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
