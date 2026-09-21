"""Offline image Skill handoff checks; no image generation or remote video calls."""
from __future__ import annotations

import copy
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import unittest
import uuid
import zlib

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills/metasocli-reference-images/scripts/validate_handoff.py"
SPEC = importlib.util.spec_from_file_location("image_handoff", SCRIPT)
assert SPEC and SPEC.loader
handoff = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(handoff)


@contextmanager
def test_directory():
    # Python 3.14's Windows private temp ACL excludes the sandbox's restricted SID.
    # Inherit this workspace's ACL and only remove this run's exact UUID directory.
    base = ROOT / ".work"
    base.mkdir(exist_ok=True)
    target = base / f"image-skill-test-{uuid.uuid4()}"
    target.mkdir()
    try:
        yield target
    finally:
        resolved = target.resolve(strict=True)
        if resolved.parent != base.resolve(strict=True) or resolved.name != target.name:
            raise RuntimeError("Refusing cleanup outside the image Skill test directory")
        shutil.rmtree(resolved)


def fixture():
    assets = []
    for order, (asset_id, kind, segments) in enumerate([
        ("lead-main", "character", ["s1"]), ("river", "scene", ["s1", "s2"]),
    ], 1):
        assets.append({
            "assetId": asset_id, "version": "v1", "order": order, "kind": kind,
            "name": asset_id, "required": True, "requiredBySegments": segments,
            "visualDescription": "原文确定的角色造型。" if kind == "character" else "原文确定的河岸空间。",
            "sourceFacts": ["第一段原文"], "continuityRequirements": ["保持原文身份和状态"],
            "exclude": [], "dependencyAssetIds": [], "exactText": [],
        })
    request = {"schemaVersion": "1.0.0", "episodeId": "ep-1", "modelPreference": None, "requireExactModel": False, "assets": assets}
    recipe = {"schemaVersion": "1.0.0", "episodeId": "ep-1", "assets": []}
    draft = {"episodeId": "ep-1", "kind": "video-prompts", "source": "source.txt", "segments": [
        {"id": "s1", "start": 0, "end": 6, "duration": 6, "references": [
            {"assetId": "lead-main", "role": "reference_image"}, {"assetId": "river", "role": "reference_image"}]},
        {"id": "s2", "start": 6, "end": 12, "duration": 6, "references": [{"assetId": "river", "role": "reference_image"}]},
    ], "recipes": []}
    for asset in assets:
        template = "character-board.md" if asset["kind"] == "character" else "scene-board.md"
        prompt = asset["visualDescription"] + "\n" + (SCRIPT.parent.parent / "references" / template).read_text(encoding="utf-8")
        recipe["assets"].append({"assetId": asset["assetId"], "kind": asset["kind"], "status": "planned",
            "generationPrompt": prompt, "recipeSha256": hashlib.sha256(handoff.normalize_prompt(prompt)).hexdigest(),
            "existingRelativePath": None, "contentSha256": None, "reason": None})
        draft["recipes"].append({"assetId": asset["assetId"], "kind": asset["kind"], "prompt": prompt, "exactText": [], "dependencies": []})
    return request, recipe, draft


def png(color: int) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
    rows = (b"\x00" + bytes([color, 100, 120]) * 256) * 256
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 256, 256, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def result_fixture(recipe, root: Path):
    result = {"schemaVersion": "1.0.0", "episodeId": "ep-1", "assets": []}
    for index, item in enumerate(recipe["assets"]):
        operation = str(uuid.uuid4())
        relative = f".metasocli/drafts/assets/{operation}/{item['assetId']}.png"
        target = root / relative
        target.parent.mkdir(parents=True)
        target.write_bytes(png(30 + index))
        result["assets"].append({"assetId": item["assetId"], "kind": item["kind"], "status": "generated",
            "operationId": operation, "stagedRelativePath": relative, "existingRelativePath": None,
            "contentSha256": hashlib.sha256(target.read_bytes()).hexdigest(), "generationPrompt": item["generationPrompt"],
            "recipeSha256": item["recipeSha256"], "generationMode": "built_in", "reportedModel": None, "reason": None})
    return result


class ImageHandoffTests(unittest.TestCase):
    def test_full_templates_transfer_without_touching_narration(self):
        request, recipe, draft = fixture()
        draft["recipes"].append({"assetId": "voice", "kind": "narration", "prompt": "用户旁白参考。", "dependencies": [], "exactText": []})
        draft["segments"][0]["narration"] = {"assetId": "voice", "cues": [{"start": 0, "end": 2}]}
        original = copy.deepcopy(draft)
        handoff.validate_request(request)
        handoff.validate_recipe(recipe, request)
        handoff.validate_import_draft(draft, request, recipe)
        self.assertEqual(draft, original)

    def test_wrong_segment_or_missing_asset_is_rejected(self):
        for mutation in ("all-segments", "omit-image", "rename-image"):
            with self.subTest(mutation=mutation):
                request, recipe, draft = fixture()
                if mutation == "all-segments":
                    request["assets"][0]["requiredBySegments"] = ["s1", "s2"]
                elif mutation == "omit-image":
                    request["assets"].pop()
                else:
                    draft["segments"][0]["references"][0]["assetId"] = "someone-else"
                with self.assertRaises(handoff.ValidationError):
                    handoff.validate_import_draft(draft, request)

    def test_dependency_allocation_is_transitive(self):
        request, recipe, draft = fixture()
        request["assets"][1]["dependencyAssetIds"] = ["lead-main"]
        draft["recipes"][1]["dependencies"] = ["lead-main"]
        with self.assertRaises(handoff.ValidationError):
            handoff.validate_import_draft(draft, request, recipe)
        request["assets"][0]["requiredBySegments"] = ["s1", "s2"]
        handoff.validate_import_draft(draft, request, recipe)

    def test_summary_or_changed_dependency_is_rejected_before_generation(self):
        for field, value in [("prompt", "简短的人物三视图"), ("dependencies", ["river"]), ("exactText", ["伪造标题"])]:
            with self.subTest(field=field):
                request, recipe, draft = fixture()
                draft["recipes"][0][field] = value
                with self.assertRaises(handoff.ValidationError):
                    handoff.validate_import_draft(draft, request, recipe)

    def test_prompt_normalization_and_limits_match_core(self):
        request, recipe, draft = fixture()
        draft["recipes"][0]["prompt"] = "\ufeff" + draft["recipes"][0]["prompt"].replace("\n", "\r\n")
        handoff.validate_import_draft(draft, request, recipe)
        prompt = "\U0001f642" * 16001
        recipe["assets"][0].update(generationPrompt=prompt, recipeSha256=hashlib.sha256(handoff.normalize_prompt(prompt)).hexdigest())
        with self.assertRaises(handoff.ValidationError):
            handoff.validate_recipe(recipe, request)

    def test_legacy_ids_audio_and_unverifiable_model_are_rejected(self):
        for field, value in [("assetId", "character/lead"), ("assetId", "con"), ("kind", "narration")]:
            with self.subTest(field=field, value=value):
                request, _, _ = fixture()
                request["assets"][0][field] = value
                with self.assertRaises(handoff.ValidationError):
                    handoff.validate_request(request)
        request, _, _ = fixture()
        request["requireExactModel"] = True
        with self.assertRaisesRegex(handoff.ValidationError, "EXACT_MODEL_UNVERIFIABLE"):
            handoff.validate_request(request)

    def test_optional_and_reuse_do_not_create_generation_recipes(self):
        request, recipe, draft = fixture()
        request["assets"][0].update(required=False, requiredBySegments=[])
        draft["segments"][0]["references"].pop(0)
        recipe["assets"][0].update(status="skipped_optional", generationPrompt=None, recipeSha256=None)
        draft["recipes"].pop(0)
        handoff.validate_request(request)
        handoff.validate_recipe(recipe, request)
        handoff.validate_import_draft(draft, request, recipe)
        recipe["assets"][1].update(status="reused", generationPrompt=None, recipeSha256=None,
            existingRelativePath="assets/river/verified.image", contentSha256="a" * 64)
        draft["recipes"] = []
        handoff.validate_recipe(recipe, request)
        handoff.validate_import_draft(draft, request, recipe)

    def test_first_frame_cannot_drop_audio_or_mix_video_inputs(self):
        request, recipe, draft = fixture()
        request["assets"][0]["kind"] = "first_frame"
        draft["segments"][0]["references"][0]["role"] = "first_frame"
        with self.assertRaises(handoff.ValidationError):
            handoff.validate_import_draft(draft, request)
        draft["segments"][0]["references"].pop()
        draft["segments"][0]["narration"] = {"assetId": "voice", "cues": [{"start": 0, "end": 1}]}
        with self.assertRaisesRegex(handoff.ValidationError, "first frame"):
            handoff.validate_import_draft(draft, request)

    def test_file_hash_actual_prompt_and_staging_namespace_are_enforced(self):
        request, recipe, _ = fixture()
        with test_directory() as temp:
            root = Path(temp)
            result = result_fixture(recipe, root)
            handoff.validate_result(result, request, recipe, root)
            for mutation in ("hash", "prompt", "old-namespace", "outside", "fallback"):
                with self.subTest(mutation=mutation):
                    invalid = copy.deepcopy(result)
                    item = invalid["assets"][0]
                    if mutation == "hash": item["contentSha256"] = "0" * 64
                    elif mutation == "prompt":
                        item["generationPrompt"] = "临时缩短的提示词"
                        item["recipeSha256"] = hashlib.sha256(handoff.normalize_prompt(item["generationPrompt"])).hexdigest()
                    elif mutation == "old-namespace": item["stagedRelativePath"] = item["stagedRelativePath"].replace(".metasocli", ".story2libtv")
                    elif mutation == "outside": item["stagedRelativePath"] = "../outside.png"
                    else: item["generationMode"] = "cli"
                    with self.assertRaises(handoff.ValidationError):
                        handoff.validate_result(invalid, request, recipe, root)

    def test_reused_file_cannot_be_substituted(self):
        request, recipe, _ = fixture()
        result = {"schemaVersion": "1.0.0", "episodeId": "ep-1", "assets": []}
        for item in recipe["assets"]:
            item.update(status="reused", generationPrompt=None, recipeSha256=None,
                existingRelativePath=f"assets/{item['assetId']}/verified.image", contentSha256="a" * 64)
            result["assets"].append({**{k: v for k, v in item.items() if k != "reason"},
                "reason": None, "operationId": None, "stagedRelativePath": None, "generationMode": "not_run", "reportedModel": None})
        handoff.validate_result(result, request, recipe, None)
        result["assets"][0]["existingRelativePath"] = "assets/different/verified.image"
        with self.assertRaisesRegex(handoff.ValidationError, "substituted"):
            handoff.validate_result(result, request, recipe, None)

    def test_offline_cli_import_registration_reuse_and_plan(self):
        node = os.environ.get("METASOCLI_TEST_NODE") or shutil.which("node")
        self.assertTrue(node, "Node 24+ is needed for the CLI smoke test")
        cli = ROOT / "dist/cli/main.js"
        self.assertTrue(cli.is_file(), "Run npm run build before this test")
        request, recipe, draft = fixture()
        environment = dict(os.environ)
        environment.pop("METASO_API_KEY", None)
        with test_directory() as temp:
            root = Path(temp) / "story"
            def run(*arguments):
                process = subprocess.run([str(node), str(cli), *arguments], env=environment, cwd=ROOT,
                    text=True, encoding="utf-8", capture_output=True, check=False)
                self.assertEqual(process.returncode, 0, process.stderr + process.stdout)
                return json.loads(process.stdout)
            run("init", "--root", str(root), "--name", "offline image Skill fixture")
            source = Path(temp) / "source.txt"
            source.write_text("人物站在河岸河水静静流淌", encoding="utf-8")
            draft["source"] = str(source)
            handoff.validate_import_draft(draft, request, recipe)
            draft_file = Path(temp) / "draft.json"
            draft_file.write_text(json.dumps(draft, ensure_ascii=False), encoding="utf-8")
            request_file, recipe_file = Path(temp) / "request.json", Path(temp) / "recipe.json"
            request_file.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
            recipe_file.write_text(json.dumps(recipe, ensure_ascii=False), encoding="utf-8")
            def run_validator(*arguments):
                process = subprocess.run([sys.executable, "-X", "utf8", "-B", str(SCRIPT), *map(str, arguments)],
                    text=True, encoding="utf-8", capture_output=True, check=False)
                self.assertEqual(process.returncode, 0, process.stderr + process.stdout)
                self.assertEqual(process.stdout.strip(), "VALID")
            run_validator("request", request_file, "--draft", draft_file)
            run_validator("recipe", recipe_file, "--request", request_file, "--draft", draft_file)
            run("import", "--root", str(root), "--draft", str(draft_file))
            result = result_fixture(recipe, root)
            handoff.validate_result(result, request, recipe, root)
            result_file = Path(temp) / "result.json"
            result_file.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            run_validator("result", result_file, "--request", request_file, "--recipe", recipe_file, "--project-root", root)
            for item in result["assets"]:
                run("assets", "register", "--root", str(root), "--id", item["assetId"], "--file", str(root / item["stagedRelativePath"]),
                    "--provenance", "imagegen", "--expected-sha256", item["contentSha256"])
            statuses = run("assets", "list", "--root", str(root))
            self.assertTrue(all(item["status"] == "ready" for item in statuses))
            manifest_before = (root / "metasocli.yaml").read_bytes()
            run("import", "--root", str(root), "--draft", str(draft_file))
            self.assertEqual(manifest_before, (root / "metasocli.yaml").read_bytes())
            plan = run("plan", "--root", str(root), "--episode", "ep-1")
            self.assertEqual(len(plan["segments"]), 2)
            self.assertEqual(list((root / ".metasocli/jobs").iterdir()), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
