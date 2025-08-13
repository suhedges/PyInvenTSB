import os
import csv
import io
import json
import time
import threading
from pathlib import Path
from flask import (
    Flask, render_template, request, redirect, url_for, session,
    jsonify, send_file, flash
)
from utils.github_sync import GithubSync
from werkzeug.utils import secure_filename

APP_DIR = Path(__file__).parent.resolve()
DATA_DIR = APP_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-" + os.urandom(16).hex())

data_lock = threading.Lock()

# ---- Config you can tweak quickly ----
REPO_OWNER = "suhedges"
REPO_NAME = "InventSB"
REPO_PATH_PREFIX = "data"  # push JSON files into repo/data/
USERS_FILE = DATA_DIR / "users.txt"      # one username per line, 3 chars, uppercase
WAREHOUSES_FILE = DATA_DIR / "warehouses.json"

# Make sure baseline files exist
if not USERS_FILE.exists():
    USERS_FILE.write_text("JMH\n", encoding="utf-8")

if not WAREHOUSES_FILE.exists():
    WAREHOUSES_FILE.write_text(json.dumps({"warehouses": []}, indent=2))

def load_users():
    return {u.strip().upper() for u in USERS_FILE.read_text(encoding="utf-8").splitlines() if u.strip()}

def _products_path(wh):
    safe = "".join(ch for ch in wh if ch.isalnum() or ch in ("-", "_")).strip()
    return DATA_DIR / f"products_{safe}.json"

def load_warehouses():
    with data_lock:
        try:
            return json.loads(WAREHOUSES_FILE.read_text(encoding="utf-8")).get("warehouses", [])
        except Exception:
            return []

def save_warehouses(warehouses):
    with data_lock:
        WAREHOUSES_FILE.write_text(json.dumps({"warehouses": warehouses}, indent=2), encoding="utf-8")
    schedule_sync(WAREHOUSES_FILE)

def load_products(warehouse):
    p = _products_path(warehouse)
    if not p.exists():
        with data_lock:
            p.write_text(json.dumps({"products": []}, indent=2), encoding="utf-8")
    with data_lock:
        try:
            return json.loads(p.read_text(encoding="utf-8")).get("products", [])
        except Exception:
            return []

def save_products(warehouse, products):
    p = _products_path(warehouse)
    with data_lock:
        p.write_text(json.dumps({"products": products}, indent=2), encoding="utf-8")
    schedule_sync(p)

# ---------- GitHub Sync (optional, best-effort/offline-friendly) ----------
github = GithubSync(
    repo_owner=REPO_OWNER, repo_name=REPO_NAME, path_prefix=REPO_PATH_PREFIX
)

_pending = set()
_lock = threading.Lock()

def schedule_sync(path: Path):
    """Queue a file to be pushed to GitHub in the background (non-blocking)."""
    with _lock:
        _pending.add(str(path.resolve()))

def background_pusher():
    while True:
        time.sleep(3)
        batch = []
        with _lock:
            if _pending:
                batch = list(_pending)
                _pending.clear()
        for fullpath in batch:
            try:
                github.push_file(Path(fullpath))
            except Exception as e:
                # Silently continue; app remains usable offline
                print("[SYNC] push failed:", e)

threading.Thread(target=background_pusher, daemon=True).start()

# ---------- Helpers ----------
def require_login():
    if "user" not in session:
        return False
    return True

def stock_bucket(prod):
    """Return 'under_min', 'over_max', or 'optimal'."""
    try:
        qty = int(prod.get("qty", 0))
        mn = int(prod.get("min", 0))
        mx = int(prod.get("max", 0))
    except Exception:
        return "optimal"
    if qty < mn:
        return "under_min"
    if qty > mx:
        return "over_max"
    return "optimal"

# ---------- Routes ----------
@app.route("/", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = (request.form.get("username") or "").strip().upper()
        # auto-cap + 3 chars enforcement
        if len(username) != 3:
            flash("Username must be exactly 3 characters.", "error")
            return redirect(url_for("login"))
        allowed = load_users()
        if username in allowed:
            session["user"] = username
            def pull():
                with data_lock:
                    github.pull_all(DATA_DIR)
            threading.Thread(target=pull, daemon=True).start()
            return redirect(url_for("warehouses"))
        flash("Unauthorized user.", "error")
        return redirect(url_for("login"))
    return render_template("login.html")

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))

@app.route("/sync")
def sync_now():
    if not require_login():
        return redirect(url_for("login"))

    def push_all():
        with data_lock:
            files = [p for p in DATA_DIR.glob("*") if p.is_file()]
        for f in files:
            try:
                github.push_file(f)
            except Exception as e:
                print("[SYNC] push failed:", e)

    threading.Thread(target=push_all, daemon=True).start()
    flash("Sync started.", "ok")
    return redirect(request.referrer or url_for("warehouses"))

@app.route("/warehouses", methods=["GET", "POST"])
def warehouses():
    if not require_login():
        return redirect(url_for("login"))
    if request.method == "POST":
        action = request.form.get("action")
        name = (request.form.get("name") or "").strip()
        if action == "add":
            if not name:
                flash("Warehouse name required.", "error")
            else:
                whs = load_warehouses()
                if any(w["name"].lower() == name.lower() for w in whs):
                    flash("Warehouse already exists.", "error")
                else:
                    whs.append({"name": name, "created_at": int(time.time())})
                    save_warehouses(whs)
                    # ensure products file exists
                    save_products(name, [])
                    flash("Warehouse added.", "ok")
        elif action == "delete":
            confirm1 = request.form.get("confirm1") == "on"
            confirm2 = request.form.get("confirm2") == "on"
            if not (confirm1 and confirm2):
                flash("Double confirmation required to delete.", "error")
            else:
                whs = load_warehouses()
                whs2 = [w for w in whs if w["name"].lower() != name.lower()]
                if len(whs2) != len(whs):
                    save_warehouses(whs2)
                    # also delete products file
                    p = _products_path(name)
                    if p.exists():
                        p.unlink()
                        schedule_sync(p)  # push deletion (will become a 404 on GitHub; ok)
                    flash("Warehouse deleted.", "ok")
                else:
                    flash("Warehouse not found.", "error")
        return redirect(url_for("warehouses"))

    return render_template("warehouses.html", warehouses=load_warehouses())

@app.route("/warehouse/<name>")
def warehouse_home(name):
    if not require_login():
        return redirect(url_for("login"))
    whs = load_warehouses()
    if not any(w["name"].lower() == name.lower() for w in whs):
        flash("Warehouse not found.", "error")
        return redirect(url_for("warehouses"))
    return render_template("warehouse.html", warehouse=name)

# ----- Products UI -----
@app.route("/warehouse/<name>/products")
def products_page(name):
    if not require_login():
        return redirect(url_for("login"))
    return render_template("products.html", warehouse=name)

# ----- Products API (CRUD + query) -----
@app.get("/api/warehouse/<name>/products")
def api_list_products(name):
    if not require_login():
        return jsonify({"error": "auth"}), 401
    prods = load_products(name)
    # Filters
    stock = request.args.get("stock")  # 'under_min' | 'over_max' | 'optimal' | None
    if stock:
        prods = [p for p in prods if stock_bucket(p) == stock]
    # Sorting
    sort = request.args.get("sort")  # 'internal_name' | 'customer_name' | 'bin'
    if sort in {"internal_name", "customer_name", "bin"}:
        prods = sorted(prods, key=lambda x: (x.get(sort, "") or "").upper())
    return jsonify({"products": prods})

@app.post("/api/warehouse/<name>/products")
def api_add_product(name):
    if not require_login():
        return jsonify({"error": "auth"}), 401
    body = request.json or {}
    required = ["internal_name", "customer_name"]
    if not all(body.get(k) for k in required):
        return jsonify({"error": "internal_name and customer_name are required"}), 400
    prods = load_products(name)
    # basic identity rule: internal_name + customer_name unique combo
    if any((p.get("internal_name","").strip().lower(), p.get("customer_name","").strip().lower()) ==
           (body["internal_name"].strip().lower(), body["customer_name"].strip().lower()) for p in prods):
        return jsonify({"error": "product already exists"}), 409
    # normalize
    newp = {
        "internal_name": body["internal_name"].strip(),
        "customer_name": body["customer_name"].strip(),
        "internal_code": body.get("internal_code","").strip(),
        "customer_code": body.get("customer_code","").strip(),
        "bin": body.get("bin","").strip(),
        "qty": int(body.get("qty") or 0),
        "min": int(body.get("min") or 0),
        "max": int(body.get("max") or 0),
        "barcode": (body.get("barcode") or "").strip(),
        "updated_at": int(time.time()),
    }
    prods.append(newp)
    save_products(name, prods)
    return jsonify({"ok": True})

@app.put("/api/warehouse/<name>/products/<int:index>")
def api_update_product(name, index):
    if not require_login():
        return jsonify({"error": "auth"}), 401
    prods = load_products(name)
    if index < 0 or index >= len(prods):
        return jsonify({"error": "not found"}), 404
    body = request.json or {}
    # selectively update fields
    for k in ["internal_name", "customer_name", "internal_code", "customer_code",
              "bin", "barcode"]:
        if k in body:
            prods[index][k] = (body.get(k) or "").strip()
    for k in ["qty", "min", "max"]:
        if k in body and body[k] is not None:
            try:
                prods[index][k] = int(body[k])
            except Exception:
                pass
    prods[index]["updated_at"] = int(time.time())
    save_products(name, prods)
    return jsonify({"ok": True})

@app.delete("/api/warehouse/<name>/products/<int:index>")
def api_delete_product(name, index):
    if not require_login():
        return jsonify({"error": "auth"}), 401
    prods = load_products(name)
    if 0 <= index < len(prods):
        prods.pop(index)
        save_products(name, prods)
        return jsonify({"ok": True})
    return jsonify({"error": "not found"}), 404

@app.get("/api/warehouse/<name>/by_barcode")
def api_find_by_barcode(name):
    if not require_login():
        return jsonify({"error": "auth"}), 401
    code = (request.args.get("code") or "").strip()
    prods = load_products(name)
    for i, p in enumerate(prods):
        if (p.get("barcode") or "").strip() == code:
            return jsonify({"index": i, "product": p})
    return jsonify({"index": None, "product": None})

@app.get("/api/warehouse/<name>/unbarcoded")
def api_unbarcoded(name):
    if not require_login():
        return jsonify({"error": "auth"}), 401
    prods = load_products(name)
    items = [(i, p) for i, p in enumerate(prods) if not (p.get("barcode") or "").strip()]
    # sort by BIN desc alpha
    items.sort(key=lambda x: (x[1].get("bin","") or "").upper(), reverse=True)
    return jsonify({"items": [{"index": i, "product": p} for i, p in items]})

# ----- Import -----
@app.route("/warehouse/<name>/import", methods=["GET", "POST"])
def import_page(name):
    if not require_login():
        return redirect(url_for("login"))
    if request.method == "POST":
        f = request.files.get("csvfile")
        if not f:
            flash("CSV file required.", "error")
            return redirect(url_for("import_page", name=name))
        data = f.read()
        try:
            text = data.decode("utf-8-sig")
        except Exception:
            text = data.decode("latin-1")
        reader = csv.DictReader(io.StringIO(text))
        required = {"Internal Product Name", "Customer Product Name"}
        headers = {h.strip(): h for h in reader.fieldnames or []}
        if not required.issubset(headers.keys()):
            flash("CSV must include 'Internal Product Name' and 'Customer Product Name'.", "error")
            return redirect(url_for("import_page", name=name))

        prods = load_products(name)
        # index by unique key (internal+customer name)
        idx = { (p.get("internal_name","").lower(), p.get("customer_name","").lower()): i for i,p in enumerate(prods) }

        def get(row, key):
            return (row.get(headers.get(key,"")) or "").strip()

        up_count = 0
        add_count = 0
        for row in reader:
            iname = get(row, "Internal Product Name")
            cname = get(row, "Customer Product Name")
            if not iname or not cname:
                continue
            key = (iname.lower(), cname.lower())
            payload = {
                "internal_name": iname,
                "customer_name": cname,
                "internal_code": get(row, "Internal Product Code"),
                "customer_code": get(row, "Customer Product Code"),
                "bin": get(row, "Bin"),
                "barcode": get(row, "Barcode"),
            }
            for kcsv, k in [("Qty","qty"), ("Min","min"), ("Max","max")]:
                v = get(row, kcsv)
                try:
                    payload[k] = int(v) if v != "" else None
                except Exception:
                    payload[k] = None

            if key in idx:
                i = idx[key]
                # merge non-empty fields
                for k in ["internal_code","customer_code","bin","barcode"]:
                    if payload[k]:
                        prods[i][k] = payload[k]
                for k in ["qty","min","max"]:
                    if payload[k] is not None:
                        prods[i][k] = payload[k]
                prods[i]["updated_at"] = int(time.time())
                up_count += 1
            else:
                prods.append({
                    "internal_name": iname,
                    "customer_name": cname,
                    "internal_code": payload["internal_code"],
                    "customer_code": payload["customer_code"],
                    "bin": payload["bin"],
                    "qty": int(payload["qty"] or 0),
                    "min": int(payload["min"] or 0),
                    "max": int(payload["max"] or 0),
                    "barcode": payload["barcode"],
                    "updated_at": int(time.time()),
                })
                add_count += 1

        save_products(name, prods)
        flash(f"Import complete. Added {add_count}, updated {up_count}.", "ok")
        return redirect(url_for("products_page", name=name))

    return render_template("import.html", warehouse=name)

# ----- Export -----
@app.route("/warehouse/<name>/export")
def export_page(name):
    if not require_login():
        return redirect(url_for("login"))
    return render_template("export.html", warehouse=name)

def _export_csv_stream(rows, filename="export.csv"):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Internal Product Name","Customer Product Name",
                     "Internal Product Code","Customer Product Code",
                     "Bin","Qty","Min","Max","Barcode"])
    for p in rows:
        writer.writerow([
            p.get("internal_name",""), p.get("customer_name",""),
            p.get("internal_code",""), p.get("customer_code",""),
            p.get("bin",""), p.get("qty",0), p.get("min",0), p.get("max",0),
            p.get("barcode","")
        ])
    mem = io.BytesIO(output.getvalue().encode("utf-8"))
    mem.seek(0)
    return send_file(mem, mimetype="text/csv", as_attachment=True, download_name=filename)

@app.get("/warehouse/<name>/export/all.csv")
def export_all(name):
    prods = load_products(name)
    return _export_csv_stream(prods, f"{secure_filename(name)}_all.csv")

@app.get("/warehouse/<name>/export/under_min.csv")
def export_under_min(name):
    prods = [p for p in load_products(name) if stock_bucket(p) == "under_min"]
    return _export_csv_stream(prods, f"{secure_filename(name)}_under_min.csv")

@app.get("/warehouse/<name>/export/over_max.csv")
def export_over_max(name):
    prods = [p for p in load_products(name) if stock_bucket(p) == "over_max"]
    return _export_csv_stream(prods, f"{secure_filename(name)}_over_max.csv")

@app.get("/warehouse/<name>/export/optimal.csv")
def export_optimal(name):
    prods = [p for p in load_products(name) if stock_bucket(p) == "optimal"]
    return _export_csv_stream(prods, f"{secure_filename(name)}_optimal.csv")

# Start
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    app.run(host="0.0.0.0", port=port, debug=True)
