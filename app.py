import os
import json
import re
import logging
import warnings
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel

warnings.simplefilter("ignore", FutureWarning)
import google.generativeai as genai
from datetime import datetime, timezone

# Configure logging
os.makedirs("/var/log/app", exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("/var/log/app/app.log"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

app = FastAPI()

APP_MODE = os.getenv("APP_MODE", os.getenv("APP_ENV", "dev")).strip().lower()

def publisher_enabled():
    return APP_MODE in {"dev", "development", "local"}

@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    if not publisher_enabled():
        path = request.url.path
        blocked_pages = {"/publisher", "/publisher.html", "/publisher.js"}
        blocked_api = {
            "/api/extract_slokas",
            "/api/process_single",
            "/api/rebuild",
            "/api/catalog/rebuild",
        }
        if path in blocked_pages:
            return PlainTextResponse("Not found", status_code=404)
        if path in blocked_api or (path == "/api/todos" and request.method != "GET"):
            return JSONResponse({"detail": "Publisher mode is disabled in production."}, status_code=404)

    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

@app.get("/app-config.js")
def app_config_js():
    mode = "dev" if publisher_enabled() else "prod"
    return PlainTextResponse(
        f'window.DURGA_APP_CONFIG = {{"mode":"{mode}","publisherEnabled":{str(publisher_enabled()).lower()}}};\n',
        media_type="application/javascript",
    )

@app.get("/publisher")
def read_publisher():
    if not publisher_enabled():
        raise HTTPException(status_code=404, detail="Publisher mode is disabled in production.")
    logger.info("Serving Publisher Mode UI")
    return FileResponse("public/publisher.html")

@app.get("/dhyana-slokas")
def read_dhyana_slokas():
    logger.info("Serving Dhyana Slokas Reader")
    return FileResponse("public/dhyana-slokas.html")

# Data models
class ProcessRequest(BaseModel):
    sloka: str
    api_key: str
    source: str
    chapter: str
    sloka_number: str
    force_overwrite: bool = False

class ExtractRequest(BaseModel):
    chapter: str
    range: str  # e.g., '1-5', 'all', 'dhyanam'

class TodoRequest(BaseModel):
    chapter: str
    item_id: str
    label: str
    title: str = ""
    source: str = "reader"

DATA_DIR = os.path.join("public", "data")
TODO_FILE = os.path.join(DATA_DIR, "todos.json")
CATALOG_FILE = os.path.join(DATA_DIR, "catalog.json")

CHAPTERS = [
    ("saptasloki", "Saptasloki", "saptasloki.md"),
    ("argala", "Argala", "argala.txt"),
    ("keelakam", "Keelakam", "keelakam.md"),
    ("ratri-suktam", "Ratri Suktam", "ratri-suktam.md"),
    *[(str(i), f"Chapter {i}", f"{i}.md") for i in range(1, 14)],
    ("devisuktam", "Devi Suktam", "devisuktam.md"),
]

def read_todos():
    if not os.path.exists(TODO_FILE):
        return []
    try:
        with open(TODO_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        logger.warning("Unable to read TODO file; returning empty list", exc_info=True)
        return []

def write_todos(todos):
    os.makedirs(os.path.dirname(TODO_FILE), exist_ok=True)
    with open(TODO_FILE, "w", encoding="utf-8") as f:
        json.dump(todos, f, ensure_ascii=False, indent=2)

def resolve_source_path(filename):
    candidates = [os.path.join("1chap.txt", filename)]
    if filename.endswith(".md"):
        candidates.append(os.path.join("1chap.txt", filename[:-3] + ".txt"))
    elif filename.endswith(".txt"):
        candidates.append(os.path.join("1chap.txt", filename[:-4] + ".md"))

    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return candidates[0]

def extract_intro_text(filepath):
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except FileNotFoundError:
        return ""

    intro_lines = []
    for line in content.splitlines():
        if line.startswith("### Dhyanam") or re.match(r"^>.*", line):
            break
        if re.search(r"[\|॥]\s*(\d+)\s*[\|॥]+", line):
            break
        intro_lines.append(line)
    return "\n".join(intro_lines).strip()

def analysis_path(chapter, item_id):
    return os.path.join(DATA_DIR, f"sloka_{chapter}_{item_id}.json")

def analysis_is_reader_ready(path):
    if not os.path.exists(path):
        return False
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return False

    sloka = str(data.get("sloka_original") or "").strip()
    meaning = data.get("tatparyam")
    has_meaning = False
    if isinstance(meaning, dict):
        has_meaning = bool(str(meaning.get("telugu") or meaning.get("english") or "").strip())
    elif isinstance(meaning, str):
        has_meaning = bool(meaning.strip())

    return bool(sloka and has_meaning)

def analysis_status_for(chapter, item_id, source_exists=True):
    path = analysis_path(chapter, item_id)
    if analysis_is_reader_ready(path):
        return "completed"
    if source_exists:
        return "todo"
    return "not_available"

def prune_completed_todos():
    todos = read_todos()
    active = [
        todo for todo in todos
        if analysis_status_for(todo.get("chapter"), todo.get("item_id"), True) != "completed"
    ]
    if len(active) != len(todos):
        write_todos(active)
    return active

def make_catalog_item(chapter, item_id, label, item_type, text="", source_exists=True):
    status = analysis_status_for(chapter, item_id, source_exists)
    return {
        "id": item_id,
        "label": label,
        "type": item_type,
        "text": text,
        "source_exists": source_exists,
        "analysis_path": f"data/sloka_{chapter}_{item_id}.json",
        "analysis_exists": status == "completed",
        "analysis_status": status,
        "is_ready": status == "completed" if item_type in {"dhyanam", "sloka"} else source_exists,
    }

def build_catalog():
    logger.info("Building catalog database at %s", CATALOG_FILE)
    chapters = []

    for chap_id, title, filename in CHAPTERS:
        filepath = resolve_source_path(filename)
        file_exists = os.path.exists(filepath)
        parsed = {}
        if file_exists:
            try:
                parsed = parse_slokas(filepath)
            except FileNotFoundError:
                parsed = {}
        else:
            logger.warning("Catalog source missing: %s", filepath)

        items = [
            {
                "id": "header",
                "label": "Header",
                "type": "metadata",
                "content": extract_intro_text(filepath) if file_exists else "",
                "source_exists": file_exists,
                "analysis_status": "completed" if file_exists else "not_available",
                "analysis_exists": file_exists,
                "is_ready": file_exists,
            }
        ]

        if "dhyanam" in parsed:
            items.append(make_catalog_item(chap_id, "dhyanam", "Dhyana Sloka", "dhyanam", parsed["dhyanam"], True))

        for num in sorted([int(k) for k in parsed.keys() if k != "dhyanam"]):
            item_id = str(num)
            items.append(make_catalog_item(chap_id, item_id, f"Sloka {num}", "sloka", parsed[item_id], True))

        chapters.append({
            "chapter": chap_id,
            "title": title,
            "filename": filename,
            "source_path": filepath,
            "file_exists": file_exists,
            "items": items,
        })

    catalog = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "chapters": chapters,
    }
    for todo in prune_completed_todos():
        chapter_data, item = find_catalog_item(catalog, todo.get("chapter"), todo.get("item_id"))
        if item:
            if item.get("analysis_status") != "completed":
                item["critical"] = bool(todo.get("critical", True))
                item["todo_count"] = int(todo.get("count", 1))
                item["analysis_status"] = "critical"
                item["is_ready"] = False
    write_catalog(catalog)
    return catalog

def read_catalog():
    if not os.path.exists(CATALOG_FILE):
        return build_catalog()
    try:
        with open(CATALOG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data.get("chapters"), list):
            return build_catalog()
        return data
    except (json.JSONDecodeError, OSError):
        logger.warning("Unable to read catalog database; rebuilding", exc_info=True)
        return build_catalog()

def write_catalog(catalog):
    os.makedirs(os.path.dirname(CATALOG_FILE), exist_ok=True)
    with open(CATALOG_FILE, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)

def find_catalog_item(catalog, chapter, item_id):
    chapter_data = next((c for c in catalog.get("chapters", []) if c.get("chapter") == chapter), None)
    if not chapter_data:
        return None, None
    item = next((i for i in chapter_data.get("items", []) if i.get("id") == item_id), None)
    return chapter_data, item

def refresh_catalog_status(chapter, item_id):
    catalog = read_catalog()
    chapter_data, item = find_catalog_item(catalog, chapter, item_id)
    if not item:
        return

    status = analysis_status_for(chapter, item_id, item.get("source_exists", True))
    item["analysis_status"] = status
    item["analysis_exists"] = status == "completed"
    item["is_ready"] = status == "completed" if item.get("type") in {"dhyanam", "sloka"} else item.get("source_exists", False)
    if status == "completed":
        item.pop("critical", None)
        item.pop("todo_count", None)
        prune_completed_todos()
    write_catalog(catalog)

def mark_catalog_todo(chapter, item_id, critical=True):
    catalog = read_catalog()
    chapter_data, item = find_catalog_item(catalog, chapter, item_id)
    if not item:
        return

    item["critical"] = critical
    item["todo_count"] = int(item.get("todo_count", 0)) + 1
    if item.get("analysis_status") != "completed":
        item["analysis_status"] = "critical" if critical else "todo"
        item["is_ready"] = False
    write_catalog(catalog)

# Parsing function
def parse_slokas(filepath):
    logger.info(f"Parsing slokas from {filepath}")
    if not os.path.exists(filepath):
        logger.error(f"File not found: {filepath}")
        raise FileNotFoundError()
        
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    content = content.replace('\r\n', '\n')
    
    slokas = {}
    dhyanam_lines = []
    
    in_dhyanam = False
    for line in content.splitlines():
        if line.startswith('>'):
            dhyanam_lines.append(line.lstrip('>').strip())
            in_dhyanam = True
        elif in_dhyanam and not line.strip():
            in_dhyanam = False
    
    if dhyanam_lines:
        slokas['dhyanam'] = '\n'.join(dhyanam_lines)

    blocks = content.split('\n\n')
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        match = re.search(r'[\|॥]\s*(\d+)\s*[\|॥]+(?:\s*\**)?$', block)
        if match:
            sloka_num = int(match.group(1))
            slokas[str(sloka_num)] = block

    logger.info(f"Successfully extracted {len(slokas)} items from {filepath}")
    return slokas

@app.post("/api/extract_slokas")
def extract_slokas(req: ExtractRequest):
    logger.info(f"ExtractRequest received for chapter: {req.chapter}, range: {req.range}")
    catalog = read_catalog()
    chapter_data = next((chapter for chapter in catalog.get("chapters", []) if chapter.get("chapter") == req.chapter), None)
    if not chapter_data:
        raise HTTPException(status_code=404, detail=f"Chapter not found for {req.chapter}")

    all_slokas = {
        item["id"]: item.get("text", "")
        for item in chapter_data.get("items", [])
        if item.get("type") in {"dhyanam", "sloka"} and item.get("text")
    }

    result = []
    r = req.range.lower().strip()
    
    if r == 'dhyanam':
        if 'dhyanam' in all_slokas:
            result.append({"number": "dhyanam", "text": all_slokas['dhyanam']})
    elif r == 'all':
        for k, v in all_slokas.items():
            result.append({"number": k, "text": v})
    elif '-' in r:
        try:
            start, end = map(int, r.split('-'))
            for i in range(start, end + 1):
                if str(i) in all_slokas:
                    result.append({"number": str(i), "text": all_slokas[str(i)]})
        except ValueError:
            logger.error(f"Invalid range format provided: {r}")
            raise HTTPException(status_code=400, detail="Invalid range format. Use '1-5'.")
    else:
        # single sloka
        if r in all_slokas:
            result.append({"number": r, "text": all_slokas[r]})
            
    logger.info(f"Returning {len(result)} slokas to UI")
    return {"slokas": result}

@app.get("/api/toc")
def get_toc():
    catalog = read_catalog()
    toc = []
    for chapter in catalog.get("chapters", []):
        items = []
        for item in chapter.get("items", []):
            if item.get("type") == "metadata" and item.get("id") != "header":
                continue
            items.append({
                "id": item.get("id"),
                "label": item.get("label"),
                "type": item.get("type"),
                "is_ready": item.get("is_ready", False),
                "analysis_status": item.get("analysis_status", "not_available"),
                "analysis_exists": item.get("analysis_exists", False),
                "source_exists": item.get("source_exists", False),
                "critical": item.get("critical", False),
                "todo_count": item.get("todo_count", 0),
            })
        toc.append({"chapter": chapter.get("chapter"), "title": chapter.get("title"), "items": items})
    return {"toc": toc}

@app.post("/api/catalog/rebuild")
def rebuild_catalog():
    catalog = build_catalog()
    return {"success": True, "chapters": len(catalog.get("chapters", [])), "generated_at": catalog.get("generated_at")}

@app.post("/api/rebuild")
def rebuild_database():
    catalog = build_catalog()
    return {"success": True, "chapters": len(catalog.get("chapters", [])), "generated_at": catalog.get("generated_at")}

@app.get("/api/todos")
def get_todos():
    return {"todos": prune_completed_todos()}

@app.post("/api/todos")
def add_todo(req: TodoRequest):
    if analysis_status_for(req.chapter, req.item_id, True) == "completed":
        prune_completed_todos()
        refresh_catalog_status(req.chapter, req.item_id)
        return {"success": True, "todos": read_todos(), "message": "Analysis already completed"}

    todos = read_todos()
    todo_id = f"{req.chapter}_{req.item_id}"
    existing = next((todo for todo in todos if todo.get("id") == todo_id), None)

    if existing:
        existing["count"] = int(existing.get("count", 1)) + 1
        existing["source"] = req.source
    else:
        todos.append({
            "id": todo_id,
            "chapter": req.chapter,
            "item_id": req.item_id,
            "label": req.label,
            "title": req.title,
            "source": req.source,
            "critical": True,
            "count": 1,
        })

    write_todos(todos)
    mark_catalog_todo(req.chapter, req.item_id, True)
    logger.info("Recorded TODO: %s", todo_id)
    return {"success": True, "todos": todos}

@app.get("/api/chapter_metadata")
def get_chapter_metadata(chapter: str, type: str):
    catalog = read_catalog()
    chapter_data, item = find_catalog_item(catalog, chapter, "header")
    if not chapter_data or not item:
        raise HTTPException(status_code=404, detail="Chapter metadata not found")
    return {"content": item.get("content", ""), "type": type}

def extract_json_text(raw_text: str) -> str:
    text = raw_text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)

    first_brace = text.find("{")
    last_brace = text.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        text = text[first_brace:last_brace + 1]

    return text

def loads_model_json(raw_text: str):
    text = extract_json_text(raw_text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Gemini occasionally emits a trailing comma before a closing object/array.
        repaired = re.sub(r",(\s*[}\]])", r"\1", text)
        return json.loads(repaired)

response_schema = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "source": {"type": "string"},
        "chapter": {"type": "string"},
        "sloka_number": {"type": "string"},
        "sloka_original": {"type": "string"},
        "padas": {
            "type": "array",
            "items": {"type": "string"}
        },
        "chandas": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "syllablesPerPada": {"type": "integer"},
                "confidence": {"type": "string"},
                "source": {"type": "string"}
            },
            "required": ["name", "confidence", "source"]
        },
        "summary": {"type": "string"},
        "words": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "word": {"type": "string"},
                    "transliteration": {"type": "string"},
                    "meaning": {"type": "string"},
                    "contextualMeaning": {"type": "string"},
                    "padaIndex": {"type": "integer"},
                    "expert": {
                        "type": "object",
                        "properties": {
                            "grammar": {"type": "string"},
                            "vibhakti": {"type": "string"},
                            "vachana": {"type": "string"},
                            "dhatu": {"type": "string"}
                        }
                    }
                },
                "required": ["word", "meaning"]
            }
        },
        "pada_vibhaga": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "word": {"type": "string"},
                    "meaning": {"type": "string"},
                    "grammar": {"type": "string"}
                },
                "required": ["word", "meaning", "grammar"]
            }
        },
        "anvaya": {"type": "string"},
        "tatparyam": {
            "type": "object",
            "properties": {
                "english": {"type": "string"},
                "telugu": {"type": "string"}
            },
            "required": ["english", "telugu"]
        },
        "samasas": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "compound": {"type": "string"},
                    "type": {"type": "string"},
                    "split": {"type": "string"},
                    "meaning": {"type": "string"},
                    "explanation": {"type": "string"}
                },
                "required": ["compound", "type"]
            }
        },
        "sandhis": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "word": {"type": "string"},
                    "split": {"type": "string"},
                    "rule": {"type": "string"}
                },
                "required": ["word", "split", "rule"]
            }
        },
        "alamkaram_chandas": {"type": "string"}
    },
    "required": ["id", "source", "chapter", "sloka_number", "sloka_original", "pada_vibhaga", "anvaya", "tatparyam", "samasas", "sandhis", "alamkaram_chandas"]
}

@app.post("/api/process_single")
def process_single_sloka(req: ProcessRequest):
    logger.info(f"ProcessRequest for Source: {req.source}, Chapter: {req.chapter}, Sloka: {req.sloka_number}, Force: {req.force_overwrite}")
    try:
        # Caching logic
        sloka_id = f"{req.source.replace(' ', '_').lower()}_{req.chapter}_{req.sloka_number}"
        output_filepath = os.path.join("public", "data", f"sloka_{req.chapter}_{req.sloka_number}.json")
        
        if not req.force_overwrite and analysis_is_reader_ready(output_filepath):
            logger.info(f"Cache hit for {output_filepath}. Returning cached data.")
            with open(output_filepath, 'r', encoding='utf-8') as f:
                existing_data = json.load(f)
            refresh_catalog_status(req.chapter, req.sloka_number)
            return {"success": True, "cached": True, "data": existing_data, "message": "Loaded from cache"}
        if not req.force_overwrite and os.path.exists(output_filepath):
            logger.info("Ignoring legacy or incomplete cache file: %s", output_filepath)

        api_key = (req.api_key or "").strip() or os.getenv("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise HTTPException(status_code=400, detail="Gemini API key is not configured. Add GEMINI_API_KEY to .env or enter a key in Publisher.")

        logger.info(f"Calling Gemini API for Sloka {req.sloka_number}")
        genai.configure(api_key=api_key)
        system_instruction = """
        You are an expert Sanskrit scholar and linguist. Your task is to process a given Sanskrit Sloka and extract reader-friendly meaning data plus grammatical details.
        First identify chandas. If Trishtubh, use 11 syllables per pada; if Jagati, use 12 syllables per pada. If a meter is reliable, include padas as one pada per string. If pada splitting is uncertain, leave padas empty or preserve the full original without inventing a split.
        Return simple word cards in words: word, transliteration, plain meaning, contextualMeaning, optional padaIndex, and deeper grammar only under expert. Keep default word meanings simple, not a dense grammar table.
        Put compounds only in samasas, including type plus split, meaning, or explanation when known.
        You must return ONLY valid JSON conforming to the schema provided.
        """
        model = genai.GenerativeModel(
            model_name="gemini-2.5-flash",
            system_instruction=system_instruction,
            generation_config=genai.GenerationConfig(
                response_mime_type="application/json",
                response_schema=response_schema,
                temperature=0.1
            )
        )
        
        prompt = f"Sloka: {req.sloka}\nSource: {req.source}\nChapter: {req.chapter}\nSloka Number: {req.sloka_number}\nID: {sloka_id}"
        
        response = model.generate_content(prompt)
        try:
            parsed_json = loads_model_json(response.text)
        except json.JSONDecodeError as decode_error:
            logger.error("Gemini returned invalid JSON for %s. Raw response excerpt: %r", sloka_id, response.text[:1200])
            raise decode_error

        parsed_json["id"] = sloka_id
        parsed_json["source"] = req.source
        parsed_json["chapter"] = req.chapter
        parsed_json["sloka_number"] = req.sloka_number
        
        logger.info(f"Gemini API success. Saving to {output_filepath}")
        with open(output_filepath, "w", encoding="utf-8") as outf:
            json.dump(parsed_json, outf, ensure_ascii=False, indent=2)
        refresh_catalog_status(req.chapter, req.sloka_number)
            
        return {"success": True, "cached": False, "data": parsed_json, "message": f"Processed sloka {req.sloka_number}"}
    except Exception as e:
        logger.error(f"Error processing sloka {req.sloka_number}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.on_event("startup")
def initialize_catalog():
    os.makedirs(DATA_DIR, exist_ok=True)
    read_catalog()

# Mount static files at the end
os.makedirs(DATA_DIR, exist_ok=True)
app.mount("/", StaticFiles(directory="public", html=True), name="static")
