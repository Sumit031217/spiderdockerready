import csv
import json
import math
import random
import socket
import time
import threading
import sys
import os
from io import StringIO
from datetime import datetime, timezone
from collections import deque

from fastapi import FastAPI, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional

from shapely.geometry import Polygon as ShapelyPolygon, LineString as ShapelyLineString, Point as ShapelyPoint
from shapely.ops import unary_union
from sqlalchemy.orm import Session
from sqlalchemy import text
from database import SessionLocal, engine, Base, SimulationRun, AlertLog, DeviceConfigDB, SchemaConfigDB, ScenarioStateDB, SensorEventDB

# ==========================================================
# SAFE ALERT ENGINE IMPORT
# ==========================================================
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

try:
    from src.alert_engine import AlertEngine
except ModuleNotFoundError:
    try:
        from alert_engine import AlertEngine
    except ModuleNotFoundError:
        raise RuntimeError("CRITICAL: Could not find 'alert_engine.py'. Ensure it is saved in simcore-backend/")

# ==========================================================
# DATABASE INITIALIZATION
# ==========================================================
try:
    Base.metadata.create_all(bind=engine)
    print("SUCCESS: Connected to PostgreSQL Database.")
    with engine.connect() as conn:
        conn = conn.execution_options(isolation_level="AUTOCOMMIT")
        try: conn.execute(text("ALTER TABLE device_configs ADD COLUMN envcategory VARCHAR DEFAULT 'GENERAL';"))
        except: pass
        try: conn.execute(text("ALTER TABLE device_configs ADD COLUMN color VARCHAR DEFAULT '#3b82f6';"))
        except: pass
        try: conn.execute(text("ALTER TABLE device_configs ADD COLUMN sourcefile VARCHAR DEFAULT 'Uploaded KML';"))
        except: pass
        try: conn.execute(text("ALTER TABLE device_configs ADD COLUMN workspace VARCHAR DEFAULT 'Default';"))
        except: pass
        try: conn.execute(text("ALTER TABLE scenario_state ADD COLUMN workspace VARCHAR DEFAULT 'Default';"))
        except: pass
        try: conn.execute(text("ALTER TABLE scenario_state ADD COLUMN kmlprobabilities TEXT DEFAULT '{}';"))
        except: pass
        try: conn.execute(text("ALTER TABLE scenario_state ADD COLUMN devicealertmapping TEXT DEFAULT '{}';"))
        except: pass
except Exception as e:
    print("\nWARNING: Could not connect to PostgreSQL Database:", e)

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()

app = FastAPI(title="SIMCORE v2.5 Backend")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

engine_lock = threading.Lock()
engine_state = {
    "is_running": False,
    "should_abort": False,
    "progress": 0,
    "total": 0,
    "logs": [],
    "map_alerts": []
}

class DeviceModel(BaseModel):
    id: str
    type: str
    lat: float = 0.0
    lng: float = 0.0
    innerRange: float = 0.0
    outerRange: float = 100.0
    azimuth: float = 0.0
    fov: float = 360.0
    alertCount: int = 0 
    packetChoice: str = "" 
    isPolygon: bool = False
    polygon: Optional[list] = []
    envCategory: Optional[str] = "GENERAL"
    color: Optional[str] = "#3b82f6"
    sourceFile: Optional[str] = "Uploaded KML"
    workspace: Optional[str] = "Default"

class SchemaModel(BaseModel):
    name: str
    separator: str
    totalIndexes: int
    schema_data: list = Field(default=[], alias="schema")

class SensorEventFieldModel(BaseModel):
    ID: int
    Name: str
    Sensor_Type: str

class SensorEventUploadModel(BaseModel):
    protocolName: str
    separator: str
    fields: List[SensorEventFieldModel]    

class ScenarioModel(BaseModel):
    name: str
    activeDevices: list
    udpIp: str
    udpPort: int
    workspace: Optional[str] = "Default"
    kmlProbabilities: Optional[dict] = {}
    deviceAlertMapping: Optional[dict] = {}

class RangeExportRequest(BaseModel):
    startTime: str
    endTime: str
    reportName: Optional[str] = "Time_Range_Report"

class DeleteBatchRequest(BaseModel):
    ids: List[str]

# ==========================================================
# MATH & PACKET GENERATION
# ==========================================================
def fast_destination(lat, lng, dist_m, bearing_deg):
    R = 6378137.0
    lat1, lng1 = math.radians(lat), math.radians(lng)
    brng = math.radians(bearing_deg)
    lat2 = math.asin(math.sin(lat1)*math.cos(dist_m/R) + math.cos(lat1)*math.sin(dist_m/R)*math.cos(brng))
    lng2 = lng1 + math.atan2(math.sin(brng)*math.sin(dist_m/R)*math.cos(lat1), math.cos(dist_m/R)-math.sin(lat1)*math.sin(lat2))
    return math.degrees(lat2), math.degrees(lng2)

def generate_uniform_distance(min_range, max_range):
    return math.sqrt(random.uniform(min_range ** 2, max_range ** 2))

def determine_priority(distance):
    if distance <= 1500: return "HIGH"
    if distance <= 3500: return "MEDIUM"
    return "LOW"

def get_distance_bearing(lat1, lon1, lat2, lon2):
    R = 6378137.0
    lat1_rad, lon1_rad = math.radians(lat1), math.radians(lon1)
    lat2_rad, lon2_rad = math.radians(lat2), math.radians(lon2)
    dlon = lon2_rad - lon1_rad
    dlat = lat2_rad - lat1_rad
    a = math.sin(dlat/2)**2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon/2)**2
    c = 2 * math.asin(math.sqrt(a))
    dist = R * c
    y = math.sin(dlon) * math.cos(lat2_rad)
    x = math.cos(lat1_rad) * math.sin(lat2_rad) - math.sin(lat1_rad) * math.cos(lat2_rad) * math.cos(dlon)
    bearing = (math.degrees(math.atan2(y, x)) + 360) % 360
    return dist, bearing

def build_dynamic_packet(alert, device, track_id, pre_sorted_schema, separator, device_alert_mapping):
    clean_type = str(device.type).upper()
    chosen_target_type = device_alert_mapping.get(device.id)

    if not pre_sorted_schema:
        clean_id = str(device.id).replace("RADAR_", "").replace("CAM_", "").replace("PIDS_", "")
        if "PIDS" in clean_type:
            target_val = chosen_target_type if chosen_target_type is not None else 1112
            return ",".join(map(str, [clean_id, 25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, target_val, 0, 0, 0, 0, 0, track_id, 0]))
        elif "CAM" in clean_type:
            target_val = chosen_target_type if chosen_target_type is not None else "Intrusion"
            return ",".join(map(str, [clean_id, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, target_val, 0, 0, 0]))
        else: 
            fov_start = (device.azimuth - (device.fov / 2)) % 360
            fov_end = (device.azimuth + (device.fov / 2)) % 360
            target_val = chosen_target_type if chosen_target_type is not None else 1
            return ",".join(map(str, [clean_id, 9, round(device.lat, 6), round(device.lng, 6), 0, round(device.azimuth, 2), round(fov_start, 2), round(fov_end, 2), track_id, round(alert["latitude"], 8), round(alert["longitude"], 8), round(alert.get("distance_m", 0), 2), round(alert.get("bearing", 0), 2), 0, target_val, int(time.time()), 0, "", 0, 0, 0]))

    packet = []
    for field in pre_sorted_schema:
        fname = field.get('name', '').lower()
        
        if 'targettype' in fname and chosen_target_type is not None:
            packet.append(str(chosen_target_type))
            continue

        if field.get('staticValue') and str(field.get('staticValue')).strip() != "":
            packet.append(str(field.get('staticValue')).strip())
            continue

        dtype = field.get('dataType', '')
        val = 0 
        
        if 'deviceid' in fname or 'sensorid' in fname: val = str(device.id).replace("RADAR_", "").replace("CAM_", "").replace("PIDS_", "")
        elif 'devicetype' in fname or 'sensortype' in fname: val = 9 if "RADAR" in clean_type else 10 if "CAM" in clean_type else 11
        elif 'devicelat' in fname or ('lat' in fname and 'target' not in fname): val = round(device.lat, 6)
        elif 'devicelong' in fname or 'devicelng' in fname or ('lon' in fname and 'target' not in fname): val = round(device.lng, 6)
        elif 'targetlat' in fname or 'alertlat' in fname: val = round(alert["latitude"], 8)
        elif 'targetlong' in fname or 'alertlong' in fname: val = round(alert["longitude"], 8)
        elif 'range' in fname or 'distance' in fname: val = round(alert.get("distance_m", 0), 2)
        elif 'bearing' in fname and 'device' not in fname: val = round(alert.get("bearing", 0), 2)
        elif 'trackid' in fname or 'nodeid' in fname: val = track_id
        elif 'time' in fname or 'timestamp' in fname: val = int(time.time())
        elif 'targettype' in fname: val = 0 
        elif 'otherinfo' in fname or 'analyticname' in fname: val = "Intrusion" if alert.get("priority") == 'HIGH' else "Motion"
        
        if dtype == 'Integer':
            try: val = int(float(val))
            except: val = 0
        elif dtype == 'Float/Double':
            try: val = float(val)
            except: val = 0.0
        elif dtype == 'String': val = str(val)
        elif dtype == 'Boolean': val = bool(val)
            
        packet.append(str(val))
    return separator.join(packet)

# ==========================================================
# SPATIAL ENGINE WITH DYNAMIC PROBABILITIES
# ==========================================================
def build_spatial_indices(env_devices):
    polygons = {}
    lines = {}

    for env in env_devices:
        poly_coords = env.get("polygon", [])
        src_file = str(env.get("sourceFile", "Uploaded KML"))
        cat = str(env.get("envCategory", "")).upper()
        if not poly_coords or len(poly_coords) < 2: continue
        
        shapely_coords = [(pt[1], pt[0]) for pt in poly_coords]
        
        is_perimeter = "PERIMETER" in src_file.upper() or "PERIMETER" in cat

        try:
            if is_perimeter:
                if shapely_coords[0] != shapely_coords[-1]:
                    shapely_coords.append(shapely_coords[0])
                lines.setdefault(src_file, []).append(ShapelyLineString(shapely_coords))
            elif "ROAD" in cat or "RAIL" in cat or len(shapely_coords) == 2:
                lines.setdefault(src_file, []).append(ShapelyLineString(shapely_coords))
            elif len(shapely_coords) >= 3:
                polygons.setdefault(src_file, []).append(ShapelyPolygon(shapely_coords))
        except Exception: continue

    return polygons, lines

def sample_spatial_point(d_obj, polygons, lines, target_assignment):
    clean_type = str(d_obj.type).upper()
    
    if "PIDS" in clean_type and d_obj.isPolygon and d_obj.polygon and len(d_obj.polygon) > 1:
        idx_poly = random.randint(0, len(d_obj.polygon) - 1)
        p1 = d_obj.polygon[idx_poly]; p2 = d_obj.polygon[(idx_poly + 1) % len(d_obj.polygon)]
        fraction = random.uniform(0, 1)
        edge_lat = p1[0] + fraction * (p2[0] - p1[0])
        edge_lng = p1[1] + fraction * (p2[1] - p1[1])
        offset_dist = random.uniform(0, 10)
        offset_bearing = random.uniform(0, 360)
        dest_lat, dest_lng = fast_destination(edge_lat, edge_lng, offset_dist, offset_bearing)
        return round(dest_lat, 8), round(dest_lng, 8), round(offset_dist, 2), round(offset_bearing, 2), "HIGH"

    def get_random_point():
        dist = generate_uniform_distance(d_obj.innerRange, d_obj.outerRange)
        bearing = random.uniform(d_obj.azimuth - (d_obj.fov / 2), d_obj.azimuth + (d_obj.fov / 2)) % 360 if "CAM" in clean_type else random.uniform(0, 360)
        cand_lat, cand_lng = fast_destination(d_obj.lat, d_obj.lng, dist, bearing)
        return round(cand_lat, 8), round(cand_lng, 8), round(dist, 2), round(bearing, 2), determine_priority(dist)

    if target_assignment == "RANDOM":
        return get_random_point()

    try:
        if target_assignment in polygons and polygons[target_assignment]:
            poly = random.choice(polygons[target_assignment])
            minx, miny, maxx, maxy = poly.bounds
            for _ in range(50):
                pnt = ShapelyPoint(random.uniform(minx, maxx), random.uniform(miny, maxy))
                if poly.contains(pnt):
                    dist, bearing = get_distance_bearing(d_obj.lat, d_obj.lng, pnt.y, pnt.x)
                    return round(pnt.y, 8), round(pnt.x, 8), round(dist, 2), round(bearing, 2), determine_priority(dist)
            
            rep = poly.representative_point()
            dist, bearing = get_distance_bearing(d_obj.lat, d_obj.lng, rep.y, rep.x)
            return round(rep.y, 8), round(rep.x, 8), round(dist, 2), round(bearing, 2), determine_priority(dist)
            
        if target_assignment in lines and lines[target_assignment]:
            line = random.choice(lines[target_assignment])
            rand_dist = random.random() * line.length
            pnt = line.interpolate(rand_dist)
            dist, bearing = get_distance_bearing(d_obj.lat, d_obj.lng, pnt.y, pnt.x)
            return round(pnt.y, 8), round(pnt.x, 8), round(dist, 2), round(bearing, 2), determine_priority(dist)
            
    except Exception:
        pass
        
    return get_random_point()

# ==========================================================
# THE HIGH PERFORMANCE ENGINE WORKER
# ==========================================================
def simulation_worker(scenarioName, udpIp, udpPort, active_devices, env_devices, schemas, minDelay, maxDelay, kml_probs, device_alert_mapping):
    global engine_state
    
    pool = []
    for dev in active_devices:
        count = int(dev.get('alertCount', 0))
        for _ in range(count): pool.append(dev)
            
    random.shuffle(pool)
    total = len(pool)

    # --- ADD THESE 4 LINES TO NORMALIZE SUMS > 1.0 ---
    if kml_probs:
        total_prob_sum = sum(float(p) for p in kml_probs.values())
        if total_prob_sum > 1.0:
            kml_probs = {k: (float(v) / total_prob_sum) for k, v in kml_probs.items()}
    # -------------------------------------------------

    assignments = []
    if kml_probs:
        for fname, prob in kml_probs.items():
            count = int(total * float(prob))
            assignments.extend([fname] * count)
            
    if len(assignments) < total:
        assignments.extend(["RANDOM"] * (total - len(assignments)))
        
    assignments = assignments[:total]
    random.shuffle(assignments)
    
    assigned_pool = list(zip(pool, assignments))

    with engine_lock:
        engine_state['is_running'] = True
        engine_state['should_abort'] = False
        engine_state['progress'] = 0
        engine_state['total'] = total
        engine_state['logs'] = [{"time": datetime.now().strftime("%H:%M:%S"), "msg": f"SYSTEM: Engaging '{scenarioName}'. Quota Engine Active.", "type": "info"}]
        engine_state['map_alerts'] = []

    if total == 0:
        with engine_lock: engine_state['is_running'] = False
        return

    polygons, lines = build_spatial_indices(env_devices)
    
    schema_cache = {}
    for s in schemas:
        schema_cache[str(s.get('name', '')).upper()] = {
            "schema": sorted(s.get('schema', []), key=lambda x: x.get('index', 0)),
            "separator": str(s.get('separator', ','))
        }

    db = SessionLocal()
    run_id = None
    try:
        db_run = SimulationRun(
            scenario_name=scenarioName, total_alerts=total, 
            timestamp=datetime.now(timezone.utc).isoformat(),
            devices_snapshot=json.dumps(active_devices + env_devices) 
        )
        db.add(db_run)
        db.commit()
        db.refresh(db_run)
        run_id = db_run.id
    except Exception as e:
        with engine_lock:
            engine_state['logs'].insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "msg": f"DB START ERROR: {str(e)}", "type": "error"})

    udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    
    batch_step = 1 
    
    class DummyDev: pass

    ui_alerts = deque(maxlen=1000)
    db_chunk = []

    for idx, (dev_dict, target_assignment) in enumerate(assigned_pool):
        with engine_lock:
            if engine_state['should_abort']:
                engine_state['logs'].insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "msg": "SYSTEM: Transmission Aborted manually.", "type": "error"})
                break

        d_obj = DummyDev()
        d_obj.id = dev_dict.get('id', '')
        d_obj.type = dev_dict.get('type', '')
        d_obj.lat = float(dev_dict.get('lat', 0.0))
        d_obj.lng = float(dev_dict.get('lng', 0.0))
        d_obj.innerRange = float(dev_dict.get('innerRange', 0.0))
        d_obj.outerRange = float(dev_dict.get('outerRange', 100.0))
        d_obj.azimuth = float(dev_dict.get('azimuth', 0.0))
        d_obj.fov = float(dev_dict.get('fov', 360.0))
        d_obj.isPolygon = bool(dev_dict.get('isPolygon', False))
        d_obj.polygon = dev_dict.get('polygon', [])
        d_obj.packetChoice = dev_dict.get('packetChoice', '')

        alert_lat, alert_lng, dist, bearing, priority = sample_spatial_point(d_obj, polygons, lines, target_assignment)
        track_id = idx + 1
        
        alert_data = {
            "run_id": run_id, "sensor_type": str(d_obj.type).upper(), "sensor_name": d_obj.id,
            "alert_id": track_id, "priority": priority, "latitude": alert_lat, "longitude": alert_lng,
            "distance_m": dist, "bearing": bearing, "timestamp": datetime.now(timezone.utc).isoformat()
        }
        
        ui_alerts.append(alert_data)
        db_chunk.append(alert_data)

        cache_entry = schema_cache.get(str(d_obj.packetChoice).upper())
        sel_schema = cache_entry['schema'] if cache_entry else None
        sel_sep = cache_entry['separator'] if cache_entry else ","

        packet_string = build_dynamic_packet(alert_data, d_obj, track_id, sel_schema, sel_sep, device_alert_mapping)
        
        try: udp_socket.sendto(packet_string.encode('utf-8'), (str(udpIp), int(udpPort)))
        except Exception: pass

        if len(db_chunk) >= 5000:
            db.bulk_insert_mappings(AlertLog, db_chunk)
            db.commit()
            db_chunk.clear()

        if idx % batch_step == 0 or idx == total - 1:
            with engine_lock:
                engine_state['progress'] = idx + 1
                engine_state['map_alerts'] = list(ui_alerts)
                engine_state['logs'].insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "msg": f"[{d_obj.id}] -> {packet_string}", "type": "success"})
                if len(engine_state['logs']) > 50:
                    engine_state['logs'] = engine_state['logs'][:50]

        delay = random.uniform(float(minDelay), float(maxDelay))
        if delay > 0: time.sleep(delay)

    udp_socket.close()
    if db_chunk:
        db.bulk_insert_mappings(AlertLog, db_chunk)
        db.commit()
        db_chunk.clear()

    if not engine_state['should_abort']:
        with engine_lock:
            engine_state['progress'] = total
            engine_state['logs'].insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "msg": f"SYSTEM: Transmission Complete. {total} packets sent and committed to DB.", "type": "info"})

    db.close()
    with engine_lock:
        engine_state['is_running'] = False


# ==========================================================
# FASTAPI ENDPOINTS
# ==========================================================
@app.post("/api/engine/clear-alerts")
def api_engine_clear_alerts():
    with engine_lock:
        engine_state["map_alerts"] = []
    return {"status": "success"}

@app.get("/api/config/sensor-events")
def get_sensor_events(db: Session = Depends(get_db)):
    events = db.query(SensorEventDB).all()
    grouped_events = {"CAMERA": [], "RADAR": [], "PIDS": []}
    for ev in events:
        stype = str(ev.sensor_type).upper()
        if stype not in grouped_events:
            grouped_events[stype] = []
        grouped_events[stype].append({"id": ev.event_id, "name": ev.name})
    return grouped_events

@app.post("/api/config/sensor-events")
def save_sensor_events(payload: SensorEventUploadModel, db: Session = Depends(get_db)):
    try:
        db.query(SensorEventDB).delete()
        for field in payload.fields:
            new_event = SensorEventDB(
                event_id=field.ID,
                name=field.Name,
                sensor_type=field.Sensor_Type
            )
            db.add(new_event)
        db.commit()
    except Exception as e:
        db.rollback()
        return {"status": "error", "message": str(e)}
    return {"status": "success"}

@app.post("/api/engine/start")
def api_engine_start(payload: dict):
    global engine_state
    with engine_lock:
        if engine_state["is_running"]: 
            return {"status": "error", "message": "Engine is already running."}
        engine_state["is_running"] = True
        engine_state["progress"] = 0
        engine_state["total"] = sum(int(d.get("alertCount", 0)) for d in payload.get("activeDevices", []))
        engine_state["map_alerts"] = []

    t = threading.Thread(
        target=simulation_worker,
        args=(
            payload["scenarioName"], payload["udpIp"], payload["udpPort"],
            payload["activeDevices"], payload["environmentDevices"], payload["sensorSchemas"],
            payload["alertConfig"]["minDelaySec"], payload["alertConfig"]["maxDelaySec"],
            payload.get("kmlProbabilities", {}),
            payload.get("deviceAlertMapping", {})
        ),
        daemon=True
    )
    t.start()
    return {"status": "success"}

@app.get("/api/engine/status")
def api_engine_status():
    with engine_lock:
        return {
            "is_running": engine_state["is_running"], "progress": engine_state["progress"],
            "total": engine_state["total"], "logs": engine_state["logs"], "map_alerts": engine_state["map_alerts"]
        }

@app.post("/api/engine/stop")
def api_engine_stop():
    with engine_lock: engine_state["should_abort"] = True
    return {"status": "success"}

@app.get("/api/state/alerts")
def get_active_alerts(db: Session = Depends(get_db)):
    last_run = db.query(SimulationRun).order_by(SimulationRun.id.desc()).first()
    if last_run:
        alerts_query = db.query(AlertLog).filter(AlertLog.run_id == last_run.id).order_by(AlertLog.id.desc()).limit(1000).all()
        return [{
            "sensor_type": a.sensor_type, "sensor_name": a.sensor_name, "alert_id": a.alert_id,
            "priority": a.priority, "latitude": a.latitude, "longitude": a.longitude,
            "distance_m": a.distance_m, "bearing": a.bearing, "timestamp": a.timestamp
        } for a in alerts_query]
    return []

def compile_kml_and_csv(report_name: str, alerts: list, devices: list):
    csv_io = StringIO()
    writer = csv.writer(csv_io)
    writer.writerow(["sensor_type", "sensor_name", "alert_id", "priority", "latitude", "longitude", "distance_m", "bearing", "timestamp"])
    for alert in alerts:
        writer.writerow([alert["sensor_type"], alert["sensor_name"], alert["alert_id"], alert["priority"], alert.get("latitude", 0), alert.get("longitude", 0), alert.get("distance_m", 0), alert.get("bearing", 0), alert["timestamp"]])
    
    kml = f'<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n    <name>{report_name}</name>\n    <Style id="radarStyle"><IconStyle><color>ff0000ff</color><scale>1.4</scale></IconStyle></Style>\n    <Style id="cameraStyle"><IconStyle><color>ffff0000</color><scale>1.4</scale></IconStyle></Style>\n    <Style id="radarHighStyle"><IconStyle><color>ff0000ff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="radarMediumStyle"><IconStyle><color>ff00ffff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="radarLowStyle"><IconStyle><color>ff00ff00</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="cameraHighStyle"><IconStyle><color>ffffffff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="cameraMediumStyle"><IconStyle><color>ffffffff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="cameraLowStyle"><IconStyle><color>ffffffff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="pidsAlertStyle"><IconStyle><color>ffffff00</color><scale>1.3</scale></IconStyle></Style>\n'
    
    for dev in devices:
        clean_type = str(dev.get("type", "")).upper()
        dev_id = dev.get("id", "Unknown")
        lat = float(dev.get("lat", 0.0))
        lng = float(dev.get("lng", 0.0))
        polygon = dev.get("polygon", [])
        
        if "ENV" in clean_type:
            hex_color = dev.get("color", "#888888").lstrip("#")
            kml_color = "ff" + hex_color[4:6] + hex_color[2:4] + hex_color[0:2]
            is_line = dev.get("envCategory") in ["ROAD", "RAILWAY"]
            if len(polygon) >= 2:
                coords_str = " ".join([f"{pt[1]},{pt[0]},0" for pt in polygon])
                if is_line: kml += f'<Placemark><name>{dev_id}</name><Style><LineStyle><color>{kml_color}</color><width>2.5</width></LineStyle></Style><LineString><coordinates>{coords_str}</coordinates></LineString></Placemark>'
                else: kml += f'<Placemark><name>{dev_id}</name><Style><LineStyle><color>{kml_color}</color><width>2.5</width></LineStyle><PolyStyle><color>66{kml_color[2:]}</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>{coords_str}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>'
            else: kml += f'<Placemark><name>{dev_id}</name><Point><coordinates>{lng},{lat},0</coordinates></Point></Placemark>'
        elif dev.get("isPolygon") and polygon:
            perimeter_coords = " ".join([f"{pt[1]},{pt[0]},0" for pt in polygon]) + f" {polygon[0][1]},{polygon[0][0]},0"
            kml += f'<Placemark><name>{dev_id} Boundary</name><Style><LineStyle><color>ff0000ff</color><width>3</width></LineStyle><PolyStyle><color>440000ff</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>{perimeter_coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>'
        else:
            style = "#radarStyle" if "RADAR" in clean_type else "#cameraStyle"
            kml += f'<Placemark><name>{dev_id}</name><styleUrl>{style}</styleUrl><Point><coordinates>{lng},{lat},0</coordinates></Point></Placemark>'
            if "CAM" in clean_type:
                azimuth, fov, outerRange = float(dev.get("azimuth", 0.0)), float(dev.get("fov", 360.0)), float(dev.get("outerRange", 100.0))
                start_bearing, end_bearing = (azimuth - (fov / 2)) % 360, (azimuth + (fov / 2)) % 360
                arc_points = []
                angle = start_bearing
                while True:
                    pt_lat, pt_lng = fast_destination(lat, lng, outerRange, angle)
                    arc_points.append(f"{pt_lng},{pt_lat},0")
                    angle = (angle + 2) % 360
                    if abs((angle - end_bearing + 360) % 360) < 2: break
                kml += f'<Placemark><name>{dev_id} FOV</name><Style><LineStyle><color>66ff0000</color><width>1</width></LineStyle><PolyStyle><color>2200ff00</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>{lng},{lat},0 {" ".join(arc_points)} {lng},{lat},0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>'
            elif "RADAR" in clean_type:
                outerRange, innerRange = float(dev.get("outerRange", 100.0)), float(dev.get("innerRange", 0.0))
                outer_pts, inner_pts = [], []
                for angle in range(361):
                    opt_lat, opt_lng = fast_destination(lat, lng, outerRange, angle)
                    ipt_lat, ipt_lng = fast_destination(lat, lng, innerRange, angle)
                    outer_pts.append(f"{opt_lng},{opt_lat},0")
                    inner_pts.append(f"{ipt_lng},{ipt_lat},0")
                kml += f'<Placemark><name>{dev_id} Boundary</name><LineString><coordinates>{" ".join(outer_pts)}</coordinates></LineString></Placemark><Placemark><name>{dev_id} Exclusion</name><LineString><coordinates>{" ".join(inner_pts)}</coordinates></LineString></Placemark>'

    for alert in alerts:
        clean_type = str(alert["sensor_type"]).upper()
        if "RADAR" in clean_type: style = "#radarHighStyle" if alert["priority"] == "HIGH" else "#radarMediumStyle" if alert["priority"] == "MEDIUM" else "#radarLowStyle"
        elif "PIDS" in clean_type: style = "#pidsAlertStyle"
        else: style = "#cameraHighStyle" if alert["priority"] == "HIGH" else "#cameraMediumStyle" if alert["priority"] == "MEDIUM" else "#cameraLowStyle"
        kml += f'<Placemark><name>{alert["sensor_name"]}_{alert["alert_id"]}</name><description>Priority: {alert["priority"]}\nDistance: {alert.get("distance_m", 0)}m\nTimestamp: {alert["timestamp"]}</description><styleUrl>{style}</styleUrl><Point><coordinates>{alert.get("longitude",0)},{alert.get("latitude",0)},0</coordinates></Point></Placemark>'
    
    kml += "\n</Document>\n</kml>"
    return {"csv_content": csv_io.getvalue(), "kml_content": kml}

@app.get("/api/runs")
def get_all_runs(db: Session = Depends(get_db)):
    runs = db.query(SimulationRun).order_by(SimulationRun.id.desc()).all()
    return [{
        "id": r.id, "scenarioName": r.scenario_name, "alertsGenerated": r.total_alerts,
        "timestamp": r.timestamp, "devices": json.loads(r.devices_snapshot) if r.devices_snapshot else []
    } for r in runs]

@app.get("/api/export/run/{run_id}")
def export_specific_run(run_id: int, db: Session = Depends(get_db)):
    run = db.query(SimulationRun).filter(SimulationRun.id == run_id).first()
    result = db.execute(text("SELECT sensor_type, sensor_name, alert_id, priority, latitude, longitude, distance_m, bearing, timestamp FROM alert_logs WHERE run_id = :rid"), {"rid": run_id})
    alerts_list = [dict(row._mapping) for row in result]
    devs_list = json.loads(run.devices_snapshot) if run.devices_snapshot else []
    return compile_kml_and_csv(f"{run.scenario_name} Report", alerts_list, devs_list)

@app.post("/api/export/range")
def generate_range_exports(payload: RangeExportRequest, db: Session = Depends(get_db)):
    result = db.execute(text("SELECT sensor_type, sensor_name, alert_id, priority, latitude, longitude, distance_m, bearing, timestamp FROM alert_logs WHERE timestamp >= :st AND timestamp <= :et"), {"st": payload.startTime, "et": payload.endTime})
    alerts_list = [dict(row._mapping) for row in result]
    devs_query = db.query(DeviceConfigDB).all()
    devs_list = [{"id": d.id, "type": d.type, "lat": d.lat, "lng": d.lng, "innerRange": d.innerRange, "outerRange": d.outerRange, "azimuth": d.azimuth, "fov": d.fov, "isPolygon": d.isPolygon, "polygon": json.loads(d.polygon) if d.polygon else [], "envCategory": getattr(d, 'envCategory', 'GENERAL'), "color": getattr(d, 'color', '#3b82f6'), "sourceFile": getattr(d, 'sourceFile', 'Uploaded KML'), "workspace": getattr(d, 'workspace', 'Default')} for d in devs_query]
    return compile_kml_and_csv(payload.reportName or "Time_Range_Report", alerts_list, devs_list)

@app.get("/api/config/devices")
def get_saved_devices(db: Session = Depends(get_db)):
    devices = db.query(DeviceConfigDB).all()
    return [{"id": d.id, "type": d.type, "lat": d.lat, "lng": d.lng, "innerRange": d.innerRange, "outerRange": d.outerRange, "azimuth": d.azimuth, "fov": d.fov, "alertCount": d.alertCount, "packetChoice": d.packetChoice, "isPolygon": d.isPolygon, "polygon": json.loads(d.polygon) if d.polygon else [], "envCategory": getattr(d, 'envCategory', 'GENERAL'), "color": getattr(d, 'color', '#3b82f6'), "sourceFile": getattr(d, 'sourceFile', 'Uploaded KML'), "workspace": getattr(d, 'workspace', 'Default')} for d in devices]

@app.post("/api/config/devices")
def save_devices(payload: List[DeviceModel], db: Session = Depends(get_db)):
    try:
        for dev in payload:
            db_dev = db.query(DeviceConfigDB).filter(DeviceConfigDB.id == dev.id).first()
            poly_str = json.dumps(dev.polygon) if dev.polygon else "[]"
            if db_dev:
                db_dev.type = str(dev.type); db_dev.lat = float(dev.lat); db_dev.lng = float(dev.lng)
                db_dev.innerRange = float(dev.innerRange); db_dev.outerRange = float(dev.outerRange)
                db_dev.azimuth = float(dev.azimuth); db_dev.fov = float(dev.fov)
                db_dev.alertCount = int(dev.alertCount); db_dev.packetChoice = str(dev.packetChoice)
                db_dev.isPolygon = bool(dev.isPolygon); db_dev.polygon = poly_str
                db_dev.envCategory = str(dev.envCategory or "GENERAL")
                db_dev.color = str(dev.color or "#3b82f6")
                db_dev.sourceFile = str(dev.sourceFile or "Uploaded KML")
                db_dev.workspace = str(dev.workspace or "Default")
            else:
                new_dev = DeviceConfigDB(id=str(dev.id), type=str(dev.type), lat=float(dev.lat), lng=float(dev.lng), innerRange=float(dev.innerRange), outerRange=float(dev.outerRange), azimuth=float(dev.azimuth), fov=float(dev.fov), alertCount=int(dev.alertCount), packetChoice=str(dev.packetChoice), isPolygon=bool(dev.isPolygon), polygon=poly_str, envCategory=str(dev.envCategory or "GENERAL"), color=str(dev.color or "#3b82f6"), sourceFile=str(dev.sourceFile or "Uploaded KML"), workspace=str(dev.workspace or "Default"))
                db.add(new_dev)
        db.commit()
    except Exception as e:
        db.rollback()
        return {"status": "error", "message": str(e)}
    return {"status": "success"}

@app.delete("/api/config/devices/{device_id}")
def delete_device(device_id: str, db: Session = Depends(get_db)):
    db.query(DeviceConfigDB).filter(DeviceConfigDB.id == device_id).delete()
    db.commit()
    return {"status": "success"}

@app.post("/api/config/devices/delete_batch")
def delete_device_batch(payload: DeleteBatchRequest, db: Session = Depends(get_db)):
    if payload.ids:
        db.query(DeviceConfigDB).filter(DeviceConfigDB.id.in_(payload.ids)).delete(synchronize_session=False)
        db.commit()
    return {"status": "success"}

@app.get("/api/config/schemas")
def get_saved_schemas(db: Session = Depends(get_db)):
    schemas = db.query(SchemaConfigDB).all()
    return [{"name": s.name, "separator": s.separator, "totalIndexes": s.totalIndexes, "schema": json.loads(s.schema_data) if s.schema_data else []} for s in schemas]

@app.post("/api/config/schemas")
def save_schemas(payload: List[SchemaModel], db: Session = Depends(get_db)):
    try:
        for s in payload:
            db_schema = db.query(SchemaConfigDB).filter(SchemaConfigDB.name == s.name).first()
            schema_str = json.dumps(s.schema_data) if s.schema_data else "[]"
            if db_schema:
                db_schema.separator = str(s.separator); db_schema.totalIndexes = int(s.totalIndexes); db_schema.schema_data = schema_str
            else:
                new_schema = SchemaConfigDB(name=str(s.name), separator=str(s.separator), totalIndexes=int(s.totalIndexes), schema_data=schema_str)
                db.add(new_schema)
        db.commit()
    except Exception as e:
        db.rollback()
        return {"status": "error", "message": str(e)}
    return {"status": "success"}

@app.delete("/api/config/schemas/{schema_name}")
def delete_schema(schema_name: str, db: Session = Depends(get_db)):
    db.query(SchemaConfigDB).filter(SchemaConfigDB.name == schema_name).delete()
    db.commit()
    return {"status": "success"}

@app.get("/api/state/scenario/{workspace_name}")
def get_scenario_state(workspace_name: str, db: Session = Depends(get_db)):
    s = db.query(ScenarioStateDB).filter(ScenarioStateDB.id == workspace_name).first()
    if s: 
        return { 
            "name": s.name, 
            "activeDevices": json.loads(s.activeDevices) if s.activeDevices else [], 
            "udpIp": s.udpIp, 
            "udpPort": s.udpPort, 
            "workspace": s.workspace,
            "kmlProbabilities": json.loads(s.kmlProbabilities) if s.kmlProbabilities else {},
            "deviceAlertMapping": json.loads(s.deviceAlertMapping) if getattr(s, 'deviceAlertMapping', None) else {}
        }
    return { "name": f"{workspace_name} Mission", "activeDevices": [], "udpIp": "127.0.0.1", "udpPort": 5005, "workspace": workspace_name, "kmlProbabilities": {}, "deviceAlertMapping": {} }

@app.post("/api/state/scenario")
def save_scenario_state(payload: ScenarioModel, db: Session = Depends(get_db)):
    target_workspace = str(payload.workspace or "Default")
    s = db.query(ScenarioStateDB).filter(ScenarioStateDB.id == target_workspace).first()
    
    dev_str = json.dumps(payload.activeDevices)
    prob_str = json.dumps(payload.kmlProbabilities) if payload.kmlProbabilities else "{}"
    map_str = json.dumps(payload.deviceAlertMapping) if getattr(payload, 'deviceAlertMapping', None) else "{}"
    
    if s:
        s.name = payload.name
        s.activeDevices = dev_str
        s.udpIp = payload.udpIp
        s.udpPort = payload.udpPort
        s.workspace = target_workspace
        s.kmlProbabilities = prob_str
        s.deviceAlertMapping = map_str
    else:
        new_s = ScenarioStateDB(
            id=target_workspace, 
            name=payload.name, 
            activeDevices=dev_str, 
            udpIp=payload.udpIp, 
            udpPort=payload.udpPort, 
            workspace=target_workspace,
            kmlProbabilities=prob_str,
            deviceAlertMapping=map_str
        )
        db.add(new_s)
    db.commit()
    return {"status": "success"}