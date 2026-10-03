"""
ComfyUI Prompt Assembler
按顺序组装提示词片段，库用 路径/层级 组织。

- 支持多个词库文件（节点包目录下的 *.yaml），每个节点/工作流可选自己的那份。
- 每个词库存在 library*.yaml，路径用 / 分层（如 角色/紫罗兰/常服1/上身服设），可手改。
- 前端面板：左边是树（找），右边是组装区（顺序、启用/禁用、分组、临时修改）。
- 输出是纯文本，不加任何权重括号，适合 Krea2 这类自然语言模型。
"""

import os
import re
import shutil
import tempfile
from datetime import datetime

try:
    import yaml
    _YAML_OK = True
except Exception:
    yaml = None
    _YAML_OK = False

from aiohttp import web
try:
    from server import PromptServer
    _HAS_SERVER = True
except Exception:
    PromptServer = None
    _HAS_SERVER = False

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_LIBRARY_NAME = "library.yaml"

LIBRARY_HEADER = """# 提示词组装器 · 词库（可手改）
#
#   path  用 / 分层，层级随便加，树会自动生成。例：角色/紫罗兰/常服1/上身服设
#   label 条目短名（显示用，可留空）
#   text  真正输出到 prompt 的文本，原样输出，不加权重括号
#
# 组装顺序不由这里决定，顺序在节点的组装区里排。
# 注意：在面板里点“保存词库到文件”会重写本文件（保留本注释头，但条目内的行内注释会丢失）。

"""

DEFAULT_LIBRARY = {
    "separator": ", ",
    "items": [],
}


# ---------------------------------------------------------------------------
# 词库名 / 路径
# ---------------------------------------------------------------------------

def _valid_library_name(name):
    if not name or not isinstance(name, str):
        return False
    name = name.strip()
    if not name.endswith((".yaml", ".yml")):
        return False
    if "/" in name or "\\" in name or name.startswith("."):
        return False
    if ".." in name:
        return False
    return True


def library_path(name=DEFAULT_LIBRARY_NAME):
    if not _valid_library_name(name):
        raise ValueError(f"非法词库名: {name!r}")
    return os.path.join(NODE_DIR, name.strip())


def list_libraries():
    names = []
    try:
        for f in os.listdir(NODE_DIR):
            if f.startswith("."):
                continue
            if ".backup_" in f:
                continue
            if f.endswith((".yaml", ".yml")):
                names.append(f)
    except Exception as e:
        print(f"[PromptAssembler] 列出词库失败: {e}")
    names.sort()
    if DEFAULT_LIBRARY_NAME not in names:
        names.insert(0, DEFAULT_LIBRARY_NAME)
    return names


def _read_library_file(p):
    if not _YAML_OK or not os.path.exists(p):
        return dict(DEFAULT_LIBRARY)
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        if not isinstance(data, dict):
            return dict(DEFAULT_LIBRARY)
        data.setdefault("separator", ", ")
        data.setdefault("items", [])
        return data
    except Exception as e:
        print(f"[PromptAssembler] 读取词库文件 {p} 失败: {e}")
        return dict(DEFAULT_LIBRARY)


def load_library(name=DEFAULT_LIBRARY_NAME):
    """读取指定词库，失败时退回默认空库。"""
    try:
        p = library_path(name)
    except ValueError:
        return dict(DEFAULT_LIBRARY)
    return _read_library_file(p)


def _normalize_library(data):
    if not isinstance(data, dict):
        raise ValueError("库必须是对象")
    items = data.get("items", [])
    if not isinstance(items, list):
        raise ValueError("items 必须是列表")
    clean_items = []
    for it in items:
        if not isinstance(it, dict):
            continue
        path = str(it.get("path", "")).strip()
        text = str(it.get("text", "") or "")
        if not path or not text.strip():
            continue
        clean_items.append({
            "path": path,
            "label": str(it.get("label", "") or "").strip(),
            "text": text,
        })
    return {
        "separator": str(data.get("separator", ", ")),
        "items": clean_items,
    }


def save_library(data, name=DEFAULT_LIBRARY_NAME):
    """原子写入指定词库，并保留最近 3 个备份。"""
    clean = _normalize_library(data)
    target = library_path(name)
    if os.path.exists(target):
        try:
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            shutil.copy2(target, f"{target}.backup_{ts}")
            base = os.path.basename(target)
            backups = sorted(
                [f for f in os.listdir(NODE_DIR) if f.startswith(base + ".backup_")],
                reverse=True,
            )
            for old in backups[3:]:
                try:
                    os.remove(os.path.join(NODE_DIR, old))
                except Exception:
                    pass
        except Exception as e:
            print(f"[PromptAssembler] 备份失败: {e}")

    fd, tmp = tempfile.mkstemp(dir=NODE_DIR, prefix=".tmp_lib_", suffix=".yaml")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(LIBRARY_HEADER)
            yaml.safe_dump(clean, f, allow_unicode=True, sort_keys=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, target)
        try:
            os.chmod(target, 0o644)
        except Exception:
            pass
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    return clean


def create_library(name, from_name=None):
    name = (name or "").strip()
    if not _valid_library_name(name):
        raise ValueError("词库名非法（需以 .yaml 结尾，不含路径分隔符）")
    target = library_path(name)
    if os.path.exists(target):
        raise ValueError("同名词库已存在")
    if from_name:
        data = load_library(from_name)
    else:
        data = dict(DEFAULT_LIBRARY)
    save_library(data, name)
    return name


# ---------------------------------------------------------------------------
# 节点
# ---------------------------------------------------------------------------

class PromptAssembler:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "assembled_prompt": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "dynamicPrompts": False,
                }),
            },
            "optional": {
                "prefix": ("STRING", {"forceInput": True}),
                "suffix": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "assemble"
    CATEGORY = "text"
    DESCRIPTION = "按组装区的顺序拼接提示词片段。打开节点上的面板编辑；词库可选。"

    def assemble(self, assembled_prompt, prefix="", suffix=""):
        sep = load_library().get("separator", ", ")
        parts = []
        for p in (prefix, assembled_prompt, suffix):
            if p is None:
                continue
            s = str(p).strip()
            if s:
                parts.append(s)
        return (sep.join(parts),)


NODE_CLASS_MAPPINGS = {"PromptAssembler": PromptAssembler}
NODE_DISPLAY_NAME_MAPPINGS = {"PromptAssembler": "提示词组装器 (Prompt Assembler)"}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]


# ---------------------------------------------------------------------------
# API 路由
# ---------------------------------------------------------------------------

if _HAS_SERVER and PromptServer is not None:
    @PromptServer.instance.routes.get("/prompt_assembler/libraries")
    async def _list_libraries(request):
        return web.json_response({"libraries": list_libraries(), "default": DEFAULT_LIBRARY_NAME})

    @PromptServer.instance.routes.get("/prompt_assembler/library")
    async def _get_library(request):
        name = request.query.get("name") or DEFAULT_LIBRARY_NAME
        return web.json_response(load_library(name))

    @PromptServer.instance.routes.post("/prompt_assembler/library")
    async def _save_library(request):
        name = request.query.get("name") or DEFAULT_LIBRARY_NAME
        try:
            data = await request.json()
            saved = save_library(data, name)
            return web.json_response(saved)
        except ValueError as e:
            return web.json_response({"error": f"数据格式错误: {e}"}, status=400)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/prompt_assembler/library/create")
    async def _create_library(request):
        try:
            body = await request.json()
            name = create_library(body.get("name"), body.get("from"))
            return web.json_response({"name": name, "libraries": list_libraries()})
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)


EXAMPLE_LIBRARY = os.path.join(NODE_DIR, "examples", "library.yaml")


def _ensure_library_exists():
    """首次运行时创建默认词库；若存在 examples/library.yaml 就以它为种子。"""
    if not _YAML_OK or os.path.exists(library_path(DEFAULT_LIBRARY_NAME)):
        return
    try:
        seed = dict(DEFAULT_LIBRARY)
        example = _read_library_file(EXAMPLE_LIBRARY)
        if example.get("items"):
            seed = example
        save_library(seed, DEFAULT_LIBRARY_NAME)
    except Exception as e:
        print(f"[PromptAssembler] 初始化词库失败: {e}")


_ensure_library_exists()
