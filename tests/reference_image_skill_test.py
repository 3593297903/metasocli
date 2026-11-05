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
    base = Path(os.environ.get("METASO_TEST_EVIDENCE_DIR", ROOT / ".work"))
    base.mkdir(parents=True, exist_ok=True)
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
    def test_all_project_entries_reach_one_fixed_workflow_without_changing_templates(self):
        shared = ROOT / "skills/metasocli-reference-images/references/image-workflow.md"
        text = shared.read_text(encoding="utf-8")
        for command in ("images prepare", "images run", "images collect", "submit_unknown"):
            self.assertIn(command, text)
        for name in ("metasocli", "metasocli-prompt-engine", "metasocli-video-prompts", "metasocli-video-prompts-旁白", "metasoclitk", "metasocli-reference-images"):
            body = (ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn("references/image-workflow.md", body)
        tk = (ROOT / "skills/metasoclitk/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("references/character-board.md", tk)
        self.assertIn("不自动附加统一旁白", tk)

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

    def test_api_execution_uses_real_job_and_receipt_evidence(self):
        node = shutil.which("node")
        self.assertTrue(node)
        request, recipe, draft = fixture()
        for item, planned in zip(draft["recipes"], recipe["assets"]):
            item["prompt"] = "完整图片原文：" + item["assetId"]
            planned["generationPrompt"] = item["prompt"]
            planned["recipeSha256"] = hashlib.sha256(item["prompt"].encode()).hexdigest()
        with test_directory() as temp:
            root = temp / "story"
            source = temp / "source.txt"
            source.write_text("人物站在河岸河水静静流淌", encoding="utf-8")
            draft["source"] = str(source)
            draft_file = temp / "draft.json"
            draft_file.write_text(json.dumps(draft, ensure_ascii=False), encoding="utf-8")
            # Use the compiled implementation with a fake response, not invented execution records.
            fake = temp / "fake.png"
            def chunk(kind, payload):
                return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
            fake.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1024, 1024, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress((b"\0" + b"\1\2\3" * 1024) * 1024)) + chunk(b"IEND", b""))
            script = temp / "api-test.mjs"
            script.write_text("\n".join([
                f"import {{initializeStory,importStory}} from {json.dumps((ROOT/'dist/core/project.js').as_uri())};",
                f"import {{createImagePlan}} from {json.dumps((ROOT/'dist/images/planning.js').as_uri())};",
                f"import {{runImages}} from {json.dumps((ROOT/'dist/images/run.js').as_uri())};",
                "import {readFile} from 'node:fs/promises';",
                f"const root={json.dumps(str(root))}; await initializeStory(root,'API handoff test');",
                f"await importStory(root,JSON.parse(await readFile({json.dumps(str(draft_file))},'utf8')));",
                "const {plan}=await createImagePlan(root,{episodes:['ep-1'],profile:{boardSize:'1024x1024',maxResponseBytes:131072,maxImageBytes:65536,maxTempBytes:10485760}});",
                f"const b64=(await readFile({json.dumps(str(fake))})).toString('base64');",
                f"await runImages(root,plan.planId,true,{{runtimeRoot:{json.dumps(str(temp/'runtime'))},client:{{async create(){{return new Response(JSON.stringify({{data:[{{b64_json:b64}}],model:'response-only-alias'}}));}}}}}});",
            ]), encoding="utf-8")
            env = dict(os.environ)
            env.pop("METASO_API_KEY", None)
            env.pop("METASOCLI_IMAGE_API_KEY", None)
            proc = subprocess.run([node, str(script)], cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", timeout=45)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            result = {"schemaVersion":"1.1.0", "episodeId":"ep-1", "assets":[]}
            jobs = {j["assetId"]: j for j in (json.loads(f.read_text()) for f in (root/".metasocli/image-jobs").glob("*.json"))}
            for planned in recipe["assets"]:
                job = jobs[planned["assetId"]]
                execution_path = f".metasocli/image-receipts/{job['operationId']}/execution.json"
                execution_file = root / execution_path
                result["assets"].append({"assetId":planned["assetId"], "kind":planned["kind"], "status":"generated",
                    "operationId":job["operationId"], "stagedRelativePath":job["result"]["path"], "existingRelativePath":None,
                    "contentSha256":job["result"]["sha256"], "generationPrompt":planned["generationPrompt"], "recipeSha256":planned["recipeSha256"],
                    "generationMode":"api", "requestedModel":"gpt-image-2.5", "reportedModel":"response-only-alias", "reason":None,
                    "executionRelativePath":execution_path, "executionSha256":hashlib.sha256(execution_file.read_bytes()).hexdigest()})
            handoff.validate_result(result, request, recipe, root)
            for field, value in [("requestedModel", "different-model"), ("reportedModel", "invented-model"), ("executionSha256", "0"*64)]:
                invalid=copy.deepcopy(result)
                invalid["assets"][0][field]=value
                with self.assertRaises(handoff.ValidationError):
                    handoff.validate_result(invalid, request, recipe, root)
            invalid=copy.deepcopy(result)
            invalid["schemaVersion"]="1.0.0"
            with self.assertRaises(handoff.ValidationError):
                handoff.validate_result(invalid, request, recipe, root)

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


class AssetDenoiseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = SCRIPT.with_name("append_asset_denoise.py")
        spec = importlib.util.spec_from_file_location("asset_denoise", cls.script)
        assert spec and spec.loader
        cls.tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.tool)
        cls.manifest, cls.texts = cls.tool.load_policy()

    def batch(self, kind="character", prompt="完整基础配方。", entry="metasoclitk"):
        return {"schemaVersion": 1, "entrySkill": entry, "items": [{"assetId": "new-asset", "kind": kind, "prompt": prompt}]}

    def test_verbatim_text_hashes_and_nine_entry_kind_mappings(self):
        expected = {"character": "fa0c6628aca1e371ffa5bf80657c3b46f14c065f4ba2683e68227d50b4145b71",
                    "scene": "455836fe6522f6663028fbac36009d4d360dae04492a52a4ab1dad0a625199c2",
                    "prop": "b334ee91c91ba678fde1a06c5520ac725e845964039e2093ec2568684ca505ac"}
        evidence = []
        for entry in sorted(self.tool.ENTRIES):
            for kind in self.tool.KINDS:
                with self.subTest(entry=entry, kind=kind):
                    template_entry = "metasoclitk" if entry == "metasoclitk" else "metasocli-reference-images"
                    base = "本故事事实与尺寸、参考角色保持。\n" + (ROOT / f"skills/{template_entry}/references/{kind}-board.md").read_text(encoding="utf-8")
                    original = self.batch(kind, base, entry)
                    saved = copy.deepcopy(original)
                    result = self.tool.compose_batch(original)
                    item = result["items"][0]
                    self.assertEqual(original, saved)
                    self.assertEqual(item["basePrompt"], base)
                    self.assertEqual(item["prompt"], base + "\n\n" + self.texts[kind])
                    self.assertEqual(hashlib.sha256(self.texts[kind].encode()).hexdigest(), expected[kind])
                    self.assertEqual(item["denoise"]["textSha256"], expected[kind])
                    self.assertEqual(item["recipeSha256"], hashlib.sha256(handoff.normalize_prompt(item["prompt"])).hexdigest())
                    self.assertEqual(self.tool.compose_batch(result), result)
                    self.tool.check_batch(result)
                    for other in self.tool.KINDS:
                        self.assertEqual(item["prompt"].count(self.texts[other]), int(other == kind))
                    evidence.append({"entry": entry, "kind": kind, "promptSha256": item["recipeSha256"], "textSha256": expected[kind], "count": 1, "atEnd": True})
        if os.environ.get("METASO_TEST_EVIDENCE_DIR"):
            (Path(os.environ["METASO_TEST_EVIDENCE_DIR"]) / "denoise-nine-mappings.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")

    def test_idempotence_normalization_and_eof_without_trimming_base(self):
        for kind in self.tool.KINDS:
            base = "  全部事实🙂\r\n视图\r尺寸\n\n"
            final = self.tool.compose_prompt("\ufeff" + base, kind)
            self.assertEqual(final, handoff.normalize_prompt(base).decode() + "\n\n" + self.texts[kind])
            for variant in (final, final.rstrip("\n"), final + "\n\n", "\ufeff" + final.replace("\n", "\r\n")):
                self.assertEqual(self.tool.compose_prompt(variant, kind), final)
                self.tool.assert_final_prompt(variant, kind)

    def test_wrong_kind_duplicate_and_position_errors_report_asset(self):
        for kind in self.tool.KINDS:
            for other in self.tool.KINDS:
                if other != kind:
                    with self.assertRaisesRegex(self.tool.ValidationError, "new-asset.*different kind"):
                        self.tool.compose_batch(self.batch(kind, "基础\n\n" + self.texts[other]))
            for value, error in [("基础\n\n" + self.texts[kind] * 2, "duplicate"),
                                 ("基础\n\n" + self.texts[kind] + "尺寸说明", "at the end"),
                                 ("基础" + self.texts[kind], "two newlines")]:
                with self.assertRaisesRegex(self.tool.ValidationError, "new-asset.*" + error):
                    self.tool.compose_batch(self.batch(kind, value))
            with self.assertRaisesRegex(self.tool.ValidationError, "missing"):
                self.tool.assert_final_prompt("只有基础", kind)

    def test_utf16_boundary_includes_full_tail_and_non_bmp(self):
        for kind in self.tool.KINDS:
            budget = 32000 - self.tool.utf16_units(self.texts[kind]) - 2
            base = "🙂" * (budget // 2) + "字" * (budget % 2)
            final = self.tool.compose_prompt(base, kind)
            self.assertEqual(self.tool.utf16_units(final), 32000)
            self.assertTrue(final.endswith(self.texts[kind]))
            with self.assertRaisesRegex(self.tool.ValidationError, "32000"):
                self.tool.compose_prompt(base + "字", kind)

    def test_nonapplicable_kinds_unchanged_and_scope_is_strict(self):
        for kind in ("first_frame", "narration"):
            text = "\ufeff原始完整文字🙂\r\n"
            result = self.tool.compose_batch(self.batch(kind, text))
            item = result["items"][0]
            self.assertEqual(item["prompt"], text)
            self.assertEqual(item["basePrompt"], text)
            self.assertEqual(item["denoise"], {"applied": False, "textSha256": None})
            self.tool.check_batch(result)
        for kind in ("Character", "人物", "unknown"):
            with self.assertRaisesRegex(self.tool.ValidationError, "new-asset.*unsupported kind"):
                self.tool.compose_batch(self.batch(kind))
        for entry in ("metasocli", "metasocli-reference-images", "metasocli-prompt-engine"):
            with self.assertRaises(self.tool.ValidationError):
                self.tool.compose_batch(self.batch(entry=entry))
        old = self.batch()
        old["items"][0]["status"] = "reused"
        with self.assertRaises(self.tool.ValidationError):
            self.tool.compose_batch(old)

    def test_final_evidence_and_base_mismatch_rejected(self):
        original = self.tool.compose_batch(self.batch())
        for field, value in (("recipeSha256", "0" * 64), ("prompt", "缩写"), ("basePrompt", "别的基础"),
                             ("denoise", {"applied": True, "textSha256": "0" * 64}), ("kind", "scene")):
            broken = copy.deepcopy(original)
            broken["items"][0][field] = value
            with self.assertRaisesRegex(self.tool.ValidationError, "new-asset"):
                self.tool.check_batch(broken)

    def test_batch_cli_readonly_collision_and_relocation(self):
        with test_directory() as temp:
            source, output = temp / "new.json", temp / "final.json"
            source.write_text(json.dumps(self.batch(), ensure_ascii=False), encoding="utf-8")
            before = source.read_bytes()
            def run(script, *args):
                return subprocess.run([sys.executable, "-X", "utf8", "-B", str(script), *map(str, args)], cwd=temp,
                                      capture_output=True, text=True, encoding="utf-8", timeout=20)
            for _ in range(2):
                proc = run(self.script, "compose", "--input", source, "--output", output)
                self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(run(self.script, "check", "--input", output).returncode, 0)
            frozen = output.read_bytes()
            self.assertNotEqual(run(self.script, "compose", "--input", source, "--output", source).returncode, 0)
            source.write_text(json.dumps(self.batch(prompt="新内容")), encoding="utf-8")
            self.assertNotEqual(run(self.script, "compose", "--input", source, "--output", output).returncode, 0)
            self.assertEqual(output.read_bytes(), frozen)
            # Actual independent package copies, no symlinks and no E: literals in the helper.
            for name in ("安装 C 布局", "安装 D 布局"):
                installed = temp / name / "skills/metasocli-reference-images"
                shutil.copytree(SCRIPT.parent.parent, installed)
                proc = run(installed / "scripts/append_asset_denoise.py", "check", "--input", output)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                (installed / "references/denoise/character.txt").write_bytes(b"changed\n")
                self.assertNotEqual(run(installed / "scripts/append_asset_denoise.py", "check", "--input", output).returncode, 0)

    def test_builtin_local_handoff_stub_carries_full_tail_and_preserves_narration(self):
        request, recipe, draft = fixture()
        prop = copy.deepcopy(request["assets"][0])
        prop.update(assetId="key", kind="prop", order=3, name="钥匙", requiredBySegments=["s1"], visualDescription="黄铜钥匙，完整未弯折。")
        request["assets"].append(prop)
        base = (SCRIPT.parent.parent / "references/prop-board.md").read_text(encoding="utf-8")
        recipe["assets"].append({"assetId":"key", "kind":"prop", "status":"planned", "generationPrompt":base,
            "recipeSha256":hashlib.sha256(handoff.normalize_prompt(base)).hexdigest(), "existingRelativePath":None, "contentSha256":None, "reason":None})
        draft["recipes"].append({"assetId":"key", "kind":"prop", "prompt":base, "exactText":[], "dependencies":[]})
        draft["segments"][0]["references"].append({"assetId":"key", "role":"reference_image"})
        draft["recipes"].append({"assetId": "voice", "kind": "narration", "prompt": "原旁白", "dependencies": [], "exactText": []})
        draft["segments"][0]["narration"] = {"assetId": "voice", "cues": [{"start": 0, "end": 2}]}
        original_segments = copy.deepcopy(draft["segments"])
        original_voice = copy.deepcopy(draft["recipes"][-1])
        for planned, target in zip(recipe["assets"], draft["recipes"]):
            final = self.tool.compose_prompt(planned["generationPrompt"], planned["kind"])
            planned.update(generationPrompt=final, recipeSha256=hashlib.sha256(handoff.normalize_prompt(final)).hexdigest())
            target["prompt"] = final
        handoff.validate_import_draft(draft, request, recipe)
        with test_directory() as temp:
            result = result_fixture(recipe, temp)  # Local stub, never imagegen.
            handoff.validate_result(result, request, recipe, temp)
            for actual, planned in zip(result["assets"], recipe["assets"]):
                self.assertEqual(actual["generationPrompt"], planned["generationPrompt"])
                self.tool.assert_final_prompt(actual["generationPrompt"], actual["kind"])
        self.assertEqual(draft["segments"], original_segments)
        self.assertEqual(draft["recipes"][-1], original_voice)

    def test_enabled_entry_docs_and_package_resource_links(self):
        for entry in self.tool.ENTRIES:
            body = (ROOT / "skills" / entry / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn("references/denoise-policy.md", body)
            self.assertIn("append_asset_denoise.py", body)
            self.assertIn("entrySkill=" + entry, body)
            shim = (ROOT / ".agents/skills" / entry / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn(f"../../../skills/{entry}/SKILL.md", shim)
        policy = (SCRIPT.parent.parent / "references/denoise-policy.md").read_text(encoding="utf-8")
        for resource in ("character.txt", "scene.txt", "prop.txt", "manifest.json"):
            self.assertIn("denoise/" + resource, policy)
            self.assertTrue((self.tool.POLICY_DIR / resource).is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
