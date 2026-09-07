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
        try: conn.execute(text("ALTER TABLE scenario_state ADD COLUMN devicedomainmapping TEXT DEFAULT '{}';"))
        except: pass
        try: conn.execute(text("ALTER TABLE scenario_state ADD COLUMN deviceswarmmode TEXT DEFAULT '{}';"))
        except: pass
        try: conn.execute(text("ALTER TABLE scenario_state ADD COLUMN deviceswarmsize TEXT DEFAULT '{}';"))
        except: pass
        try: conn.execute(text("ALTER TABLE scenario_state ADD COLUMN deviceswarmarc TEXT DEFAULT '{}';"))
        except: pass
        try: conn.execute(text("ALTER TABLE scenario_state ADD COLUMN devicegroundmode TEXT DEFAULT '{}';"))
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
    id: Optional[str] = None
    name: str
    activeDevices: list
    udpIp: str
    udpPort: int
    workspace: Optional[str] = "Default"
    kmlProbabilities: Optional[dict] = {}
    deviceAlertMapping: Optional[dict] = {}
    deviceDomainMapping: Optional[dict] = {}
    deviceSwarmMode: Optional[dict] = {}
    deviceSwarmSize: Optional[dict] = {}
    deviceSwarmArc: Optional[dict] = {}

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

def build_dynamic_packet(alert, device, track_id, pre_sorted_schema, separator, device_alert_mapping, device_domain_mapping):
    clean_type = device.clean_type
    chosen_target_type = device_alert_mapping.get(device.id)

    # --- 3D KINEMATIC DOMAIN ENGINE ---
    domain = device_domain_mapping.get(device.id, "GROUND")
    if domain == "BOTH":
        domain = random.choice(["GROUND", "AIRBORNE"])
        
    dist_m = alert.get("distance_m", 0)
    
# --- SWARM STATE OVERRIDE ---
    if alert.get("is_swarm"):
        target_height = alert.get("height", 0)
        target_speed = alert.get("speed", 0)
        target_elevation = alert.get("elevation", 0)
    # --- NORMAL MODE ---
    elif domain == "AIRBORNE":
        target_height = round(random.uniform(25, 300), 2)
        target_speed = round(random.uniform(30, 120), 2)
        target_elevation = round(math.degrees(math.atan2(target_height, dist_m)), 2) if dist_m > 0 else 90.0
    else:
        target_height = 0
        target_speed = round(random.uniform(2, 15), 2)
        target_elevation = 0

    if not pre_sorted_schema:
        clean_id = str(device.id).replace("RADAR_", "").replace("CAM_", "").replace("PIDS_", "")
        if "PIDS" in clean_type:
            target_val = chosen_target_type if chosen_target_type is not None else 1112
            return ",".join(map(str, [clean_id, 25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, target_val, 0, 0, 0, 0, 0, track_id, 0]))
        else: 
            fov_start = (device.azimuth - (device.fov / 2)) % 360
            fov_end = (device.azimuth + (device.fov / 2)) % 360
            target_val = chosen_target_type if chosen_target_type is not None else 1
            return ",".join(map(str, [clean_id, 9, round(device.lat, 6), round(device.lng, 6), 0, round(device.azimuth, 2), round(fov_start, 2), round(fov_end, 2), track_id, round(alert["latitude"], 8), round(alert["longitude"], 8), round(alert.get("distance_m", 0), 2), round(alert.get("bearing", 0), 2), 0, target_val, int(time.time()), 0, "Event", 0, 0, 0]))

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
        
        if 'deviceid' in fname or 'sensorid' in fname: val = str(device.id)
        elif 'devicetype' in fname or 'sensortype' in fname: val = 0 
        elif 'devicelat' in fname or ('lat' in fname and 'target' not in fname): val = round(device.lat, 6)
        elif 'devicelong' in fname or 'devicelng' in fname or ('lon' in fname and 'target' not in fname): val = round(device.lng, 6)
        elif 'targetlat' in fname or 'alertlat' in fname: val = round(alert["latitude"], 8)
        elif 'targetlong' in fname or 'alertlong' in fname: val = round(alert["longitude"], 8)
        elif 'range' in fname or 'distance' in fname: val = round(dist_m, 2)
        elif 'bearing' in fname and 'device' not in fname: val = round(alert.get("bearing", 0), 2)
        
        elif 'fovstart' in fname: val = 0 if device.fov >= 360 else round((device.azimuth - (device.fov / 2)) % 360, 2)
        elif 'fovend' in fname: val = 360 if device.fov >= 360 else round((device.azimuth + (device.fov / 2)) % 360, 2)
            
        elif 'targetspeed' in fname or 'velocity' in fname: val = target_speed
        elif 'targetelevation' in fname or 'pitch' in fname: val = target_elevation
        elif 'targetheight' in fname or 'altitude' in fname: val = target_height
            
        elif 'trackid' in fname or 'nodeid' in fname: val = track_id
        elif 'time' in fname or 'timestamp' in fname: val = int(time.time())
        elif 'otherinfo' in fname or 'analyticname' in fname: val = str(chosen_target_type) if chosen_target_type else "System Event"
        
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
# CACHED SPATIAL ENGINE WITH PRE-FLIGHT INDEXER
# ==========================================================
def build_spatial_indices(env_devices):
    polygons = {}
    lines = {}

    for env in env_devices:
        poly_coords = env.get("polygon", [])
        # Force all dictionary keys to be clean, uppercase strings
        src_file = str(env.get("sourceFile", "Uploaded KML")).strip().upper()
        cat = str(env.get("envCategory", "")).upper()
        if not poly_coords or len(poly_coords) < 2: continue
        
        shapely_coords = [(pt[1], pt[0]) for pt in poly_coords]
        is_perimeter = "PERIMETER" in src_file.upper() or "PERIMETER" in cat

        try:
            if is_perimeter:
                if shapely_coords[0] != shapely_coords[-1]: shapely_coords.append(shapely_coords[0])
                line = ShapelyLineString(shapely_coords)
                mid = line.interpolate(0.5, normalized=True)
                lines.setdefault(src_file, []).append({"geom": line, "length": line.length, "rep_point": (mid.y, mid.x)})
            elif "ROAD" in cat or "RAIL" in cat or len(shapely_coords) == 2:
                line = ShapelyLineString(shapely_coords)
                mid = line.interpolate(0.5, normalized=True)
                lines.setdefault(src_file, []).append({"geom": line, "length": line.length, "rep_point": (mid.y, mid.x)})
            elif len(shapely_coords) >= 3:
                poly = ShapelyPolygon(shapely_coords)
                rep = poly.representative_point()
                polygons.setdefault(src_file, []).append({"geom": poly, "bounds": poly.bounds, "rep_point": (rep.y, rep.x)})
        except Exception: continue

    return polygons, lines

def precompute_device_targets(active_devices, polygons, lines):
    cache = {}
    # FIX: Now loops over active_devices directly instead of task_pool
    for dev_dict in active_devices:
        d_obj = OptimizedDevice(dev_dict)
        if d_obj.id in cache: continue
        cache[d_obj.id] = {"polygons": {}, "lines": {}}
        
        def is_roughly_visible(dist, bearing):
            if dist > d_obj.outerRange + 500: return False
            if d_obj.fov < 360:
                start_b = (d_obj.azimuth - (d_obj.fov / 2) - 30) % 360
                end_b = (d_obj.azimuth + (d_obj.fov / 2) + 30) % 360
                if start_b <= end_b:
                    if not (start_b <= bearing <= end_b): return False
                else:
                    if not (bearing >= start_b or bearing <= end_b): return False
            return True

        for fname, poly_list in polygons.items():
            valid_polys = []
            for p in poly_list:
                dist, bearing = get_distance_bearing(d_obj.lat, d_obj.lng, p["rep_point"][0], p["rep_point"][1])
                if is_roughly_visible(dist, bearing): valid_polys.append(p)
            cache[d_obj.id]["polygons"][fname] = valid_polys
            
        for fname, line_list in lines.items():
            valid_lines = []
            for l in line_list:
                dist, bearing = get_distance_bearing(d_obj.lat, d_obj.lng, l["rep_point"][0], l["rep_point"][1])
                if is_roughly_visible(dist, bearing): valid_lines.append(l)
            cache[d_obj.id]["lines"][fname] = valid_lines
            
    return cache


def sample_spatial_point(d_obj, target_assignment, device_target_cache):
    clean_type = d_obj.clean_type
    
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

    def is_valid_physics(dist, bearing):
        if not (d_obj.innerRange <= dist <= d_obj.outerRange): return False
        if d_obj.fov < 360:
            start_b = (d_obj.azimuth - (d_obj.fov / 2)) % 360
            end_b = (d_obj.azimuth + (d_obj.fov / 2)) % 360
            if start_b <= end_b:
                if not (start_b <= bearing <= end_b): return False
            else:
                if not (bearing >= start_b or bearing <= end_b): return False
        return True

    def get_random_point():
        dist = generate_uniform_distance(d_obj.innerRange, d_obj.outerRange)
        bearing = random.uniform(0, 360) if d_obj.fov >= 360 else random.uniform(d_obj.azimuth - (d_obj.fov / 2), d_obj.azimuth + (d_obj.fov / 2)) % 360
        cand_lat, cand_lng = fast_destination(d_obj.lat, d_obj.lng, dist, bearing)
        return round(cand_lat, 8), round(cand_lng, 8), round(dist, 2), round(bearing, 2), determine_priority(dist)

    if target_assignment == "RANDOM":
        return get_random_point()

    try:
        # --- POLYGON STRICT CHECK ---
        if target_assignment in device_target_cache[d_obj.id]["polygons"]:
            valid_polys = device_target_cache[d_obj.id]["polygons"][target_assignment]
            if not valid_polys:
                return get_random_point()
            
            # Shuffle the roughly visible buildings so we check randomly
            shuffled_polys = valid_polys[:]
            random.shuffle(shuffled_polys)
            
            for cached_poly in shuffled_polys:
                poly = cached_poly["geom"]
                minx, miny, maxx, maxy = cached_poly["bounds"]
                
                # Try to find a STRICTLY VALID point inside this specific building
                for _ in range(30):
                    pnt = ShapelyPoint(random.uniform(minx, maxx), random.uniform(miny, maxy))
                    if poly.contains(pnt):
                        dist, bearing = get_distance_bearing(d_obj.lat, d_obj.lng, pnt.y, pnt.x)
                        # NO FORCING. If it fails this strict check, it loops again.
                        if is_valid_physics(dist, bearing):
                            return round(pnt.y, 8), round(pnt.x, 8), round(dist, 2), round(bearing, 2), determine_priority(dist)
            
            # If we checked EVERY roughly visible building and none intersect the strict physics cone...
            # We absolutely DO NOT force it. We fall back to random inside the valid FOV.
            return get_random_point()
                
        # --- LINE STRICT CHECK ---
        if target_assignment in device_target_cache[d_obj.id]["lines"]:
            valid_lines = device_target_cache[d_obj.id]["lines"][target_assignment]
            if not valid_lines:
                return get_random_point()
                
            shuffled_lines = valid_lines[:]
            random.shuffle(shuffled_lines)
            
            for cached_line in shuffled_lines:
                line = cached_line["geom"]
                line_len = cached_line["length"]
                
                for _ in range(20):
                    rand_dist = random.random() * line_len
                    pnt = line.interpolate(rand_dist)
                    dist, bearing = get_distance_bearing(d_obj.lat, d_obj.lng, pnt.y, pnt.x)
                    if is_valid_physics(dist, bearing):
                        return round(pnt.y, 8), round(pnt.x, 8), round(dist, 2), round(bearing, 2), determine_priority(dist)
            
            return get_random_point()
            
    except Exception:
        pass
        
    return get_random_point()
# ==========================================================
# THE HIGH PERFORMANCE ENGINE WORKER (MEMORY OPTIMIZED)
# ==========================================================
class OptimizedDevice:
    __slots__ = ['id', 'type', 'clean_type', 'lat', 'lng', 'innerRange', 'outerRange', 'azimuth', 'fov', 'isPolygon', 'polygon', 'packetChoice']
    def __init__(self, d):
        self.id = d.get('id', '')
        self.type = d.get('type', '')
        self.clean_type = str(self.type).upper()
        self.lat = float(d.get('lat', 0.0))
        self.lng = float(d.get('lng', 0.0))
        self.innerRange = float(d.get('innerRange', 0.0))
        self.outerRange = float(d.get('outerRange', 100.0))
        self.azimuth = float(d.get('azimuth', 0.0))
        self.fov = float(d.get('fov', 360.0))
        self.isPolygon = bool(d.get('isPolygon', False))
        self.polygon = d.get('polygon', [])
        self.packetChoice = d.get('packetChoice', '')

def simulation_worker(scenarioName, udpIp, udpPort, active_devices, env_devices, schemas, minDelay, maxDelay, kml_probs, device_alert_mapping, device_domain_mapping, device_swarm_mode, device_swarm_size, device_swarm_arc, batch_mode=False, batch_size=50, batch_interval=5.0):
    global engine_state
    
    try:
        # 1. PRE-FLIGHT INDEXING MUST HAPPEN FIRST!
        polygons, lines = build_spatial_indices(env_devices)
        device_target_cache = precompute_device_targets(active_devices, polygons, lines)

        if kml_probs:
            total_prob_sum = sum(float(p) for p in kml_probs.values())
            if total_prob_sum > 1.0:
                kml_probs = {k: (float(v) / total_prob_sum) for k, v in kml_probs.items()}

        # CRITICAL FIX: De-duplicate incoming payload by Device ID to prevent overlapping scenarios
        unique_active_devices = {d.get("id"): d for d in active_devices}.values()

        task_pool = []
        total_alerts_requested = 0
        swarm_track_counter = 10000000  # 10 Million buffer to allow massive generation without collisions

        for dev_dict in unique_active_devices:
            dev_total = int(dev_dict.get('alertCount', 0))
            if dev_total <= 0: continue
            total_alerts_requested += dev_total
            
            d_obj = OptimizedDevice(dev_dict)
            is_swarm = device_swarm_mode.get(d_obj.id, False)
            
            if is_swarm:
                swarm_size = int(device_swarm_size.get(d_obj.id, 5))
                packets_per_drone = max(1, dev_total // max(1, swarm_size))
                
                # --- AUTO-SCALING TARGET GEOMETRY ---
                target_lat, target_lng = d_obj.lat, d_obj.lng 
                target_radius_m = 30.0 # Default fallback if no KML is found
                
                sensor_cache = device_target_cache.get(d_obj.id, {})
                found_target = False
                
                # 1. Hunt for Perimeter and calculate its exact physical radius
                for p_dict in [sensor_cache.get("polygons", {}), sensor_cache.get("lines", {})]:
                    for fname, items in p_dict.items():
                        if "PERIMETER" in fname and items:
                            target_lat, target_lng = items[0]["rep_point"]
                            bounds = items[0].get("bounds")
                            if bounds:
                                minx, miny, maxx, maxy = bounds
                                diag_dist, _ = get_distance_bearing(miny, minx, maxy, maxx)
                                target_radius_m = diag_dist / 2  # The physical half-width of the building
                            found_target = True
                            break
                    if found_target: break
                    
                # 2. Fallback to first available building and measure it
                if not found_target and sensor_cache.get("polygons"):
                    first_key = list(sensor_cache["polygons"].keys())[0]
                    if sensor_cache["polygons"][first_key]:
                        target_lat, target_lng = sensor_cache["polygons"][first_key][0]["rep_point"]
                        bounds = sensor_cache["polygons"][first_key][0].get("bounds")
                        if bounds:
                            minx, miny, maxx, maxy = bounds
                            diag_dist, _ = get_distance_bearing(miny, minx, maxy, maxx)
                            target_radius_m = diag_dist / 2

                # --- AUTO-SCALING SWARM FORMATION ---
                base_angle = d_obj.azimuth if d_obj.fov < 360 else random.uniform(0, 360)
                
                # Check if user explicitly set an arc, otherwise fallback to defaults
                custom_arc = device_swarm_arc.get(d_obj.id)
                if custom_arc is not None:
                    arc_spread = float(custom_arc)
                else:
                    arc_spread = (d_obj.fov * 0.60) if d_obj.fov < 360 else 90.0
                    
                # Dynamically scales swarm depth to 15% of the sensor's absolute range
                max_stagger_depth = max(10, d_obj.outerRange * 0.15) 

                drones = []
                for i in range(swarm_size):
                    # Random spacing INSIDE the tight arc
                    angle_offset = random.uniform(-arc_spread / 2, arc_spread / 2)
                    drone_spawn_angle = (base_angle + angle_offset) % 360
                    
                    # Spawns them dynamically at the outer rim, staggered by the 15% depth
                    chaotic_spawn_distance = d_obj.outerRange - random.uniform(0, max_stagger_depth)
                    start_lat, start_lng = fast_destination(d_obj.lat, d_obj.lng, chaotic_spawn_distance, drone_spawn_angle)
                    
                    # Engulfs the perimeter dynamically (between 50% and 120% of the building's measured size)
                    end_spread = random.uniform(target_radius_m * 0.5, target_radius_m * 1.2)
                    
                    # THE FIX: Preserve 360 logic for omni sensors, bound the angle strictly for directional sensors
                    if d_obj.fov >= 360:
                        end_angle = random.uniform(0, 360)
                    else:
                        fov_start = d_obj.azimuth - (d_obj.fov / 2)
                        fov_end = d_obj.azimuth + (d_obj.fov / 2)
                        end_angle = random.uniform(fov_start, fov_end) % 360
                        
                    end_lat, end_lng = fast_destination(target_lat, target_lng, end_spread, end_angle)
                    
                    drones.append({
                        "track_id": swarm_track_counter,
                        "start": (start_lat, start_lng),
                        "end": (end_lat, end_lng),
                        "speed": round(random.uniform(50, 90), 2),
                        "height": round(random.uniform(50, 200), 2),
                        "total_steps": packets_per_drone,
                        "current_step": 0
                    })
                    swarm_track_counter += 1
                
                task_pool.append({
                    "dev": d_obj, "target": "SWARM", "remaining": dev_total, 
                    "drones": drones, "current_drone_idx": 0
                })
            else:
                allocated = 0
                if kml_probs:
                    for fname, prob in kml_probs.items():
                        count = int(dev_total * float(prob))
                        if count > 0:
                            clean_target = str(fname).strip().upper()
                            task_pool.append({"dev": d_obj, "target": clean_target, "remaining": count})
                            allocated += count
                            
                remainder = dev_total - allocated
                if remainder > 0:
                    task_pool.append({"dev": d_obj, "target": "RANDOM", "remaining": remainder})

        with engine_lock:
            engine_state['is_running'] = True
            engine_state['should_abort'] = False
            engine_state['progress'] = 0
            engine_state['total'] = total_alerts_requested
            engine_state['logs'] = [{"time": datetime.now().strftime("%H:%M:%S"), "msg": f"SYSTEM: Engaging '{scenarioName}'. Swarm/Kinematics Active.", "type": "info"}]
            engine_state['map_alerts'] = []

        if total_alerts_requested == 0 or not task_pool:
            return

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
                scenario_name=scenarioName, total_alerts=total_alerts_requested, 
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
        ui_alerts = deque(maxlen=1000)
        db_chunk = []
        last_ui_update_time = 0

        for current_idx in range(total_alerts_requested):
            with engine_lock:
                if engine_state['should_abort']:
                    engine_state['logs'].insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "msg": "SYSTEM: Transmission Aborted manually.", "type": "error"})
                    break

            task_idx = random.randrange(len(task_pool))
            current_task = task_pool[task_idx]
            
            d_obj = current_task["dev"]
            target_assignment = current_task["target"]

            if target_assignment == "SWARM":
                drone = current_task["drones"][current_task["current_drone_idx"]]
                
                # --- PURE KINEMATIC INTERPOLATION ---
                fraction = drone["current_step"] / max(1, drone["total_steps"])
                
                # Pure smooth math
                alert_lat = drone["start"][0] + (drone["end"][0] - drone["start"][0]) * fraction
                alert_lng = drone["start"][1] + (drone["end"][1] - drone["start"][1]) * fraction
                
                dist, bearing = get_distance_bearing(d_obj.lat, d_obj.lng, alert_lat, alert_lng)
                
                track_id = drone["track_id"]
                priority = determine_priority(dist)
                
                locked_height = drone["height"]
                locked_speed = drone["speed"]
                locked_elevation = round(math.degrees(math.atan2(locked_height, dist)), 2) if dist > 0 else 90.0
                
                drone["current_step"] += 1
                current_task["current_drone_idx"] = (current_task["current_drone_idx"] + 1) % len(current_task["drones"])
                
                swarm_overrides = {
                    "is_swarm": True,
                    "height": locked_height,
                    "speed": locked_speed,
                    "elevation": locked_elevation
                }
            else:
                alert_lat, alert_lng, dist, bearing, priority = sample_spatial_point(d_obj, target_assignment, device_target_cache)
                track_id = current_idx + 1
                swarm_overrides = {"is_swarm": False}
            
            alert_data = {
                "run_id": run_id, "sensor_type": d_obj.clean_type, "sensor_name": d_obj.id,
                "alert_id": track_id, "priority": priority, "latitude": alert_lat, "longitude": alert_lng,
                "distance_m": dist, "bearing": bearing, "timestamp": datetime.now(timezone.utc).isoformat(),
                **swarm_overrides
            }
            
            ui_alerts.append(alert_data)
            db_chunk.append(alert_data)

            cache_entry = schema_cache.get(str(d_obj.packetChoice).upper())
            sel_schema = cache_entry['schema'] if cache_entry else None
            sel_sep = cache_entry['separator'] if cache_entry else ","

            packet_string = build_dynamic_packet(alert_data, d_obj, track_id, sel_schema, sel_sep, device_alert_mapping, device_domain_mapping)
            
            try: udp_socket.sendto(packet_string.encode('utf-8'), (str(udpIp), int(udpPort)))
            except Exception: pass

            if len(db_chunk) >= 5000:
                db.bulk_insert_mappings(AlertLog, db_chunk)
                db.commit()
                db_chunk.clear()

            current_time = time.time()
            if (current_time - last_ui_update_time >= 0.25) or (current_idx == total_alerts_requested - 1):
                with engine_lock:
                    engine_state['progress'] = current_idx + 1
                    engine_state['map_alerts'] = list(ui_alerts)
                    engine_state['logs'].insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "msg": f"[{d_obj.id}] -> {packet_string}", "type": "success"})
                    if len(engine_state['logs']) > 50:
                        engine_state['logs'] = engine_state['logs'][:50]
                last_ui_update_time = current_time

            current_task["remaining"] -= 1
            if current_task["remaining"] <= 0:
                task_pool[task_idx] = task_pool[-1]
                task_pool.pop()

            # THE FIX: Additive Batch Mode Logic (Protects original logic)
            if batch_mode:
                safe_batch_size = max(1, int(batch_size))
                # Trigger sleep ONLY if we hit the heap limit, or if it's the final packet of the mission
                if (current_idx + 1) % safe_batch_size == 0 or current_idx == total_alerts_requested - 1:
                    if float(batch_interval) > 0:
                        time.sleep(float(batch_interval))
            else:
                # ORIGINAL LOGIC: Sequential random physics
                delay = random.uniform(float(minDelay), float(maxDelay))
                if delay > 0: time.sleep(delay)

        udp_socket.close()
        if db_chunk:
            db.bulk_insert_mappings(AlertLog, db_chunk)
            db.commit()
            db_chunk.clear()

        if not engine_state['should_abort']:
            with engine_lock:
                engine_state['progress'] = total_alerts_requested
                engine_state['logs'].insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "msg": f"SYSTEM: Transmission Complete.", "type": "info"})

        db.close()

    except Exception as e:
        print(f"\n[CRITICAL ENGINE FAULT]: {e}\n")
        with engine_lock:
            engine_state['logs'].insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "msg": f"CRITICAL ENGINE FAULT: {str(e)}. Review terminal for details.", "type": "error"})
            
    finally:
        with engine_lock:
            engine_state['is_running'] = False


# ==========================================================
# FASTAPI ENDPOINTS & EXPORTERS
# ==========================================================
@app.post("/api/engine/clear-alerts")
def api_engine_clear_alerts():
    with engine_lock: engine_state["map_alerts"] = []
    return {"status": "success"}

@app.get("/api/config/sensor-events")
def get_sensor_events(db: Session = Depends(get_db)):
    events = db.query(SensorEventDB).all()
    grouped_events = {}
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
            new_event = SensorEventDB(event_id=field.ID, name=field.Name, sensor_type=field.Sensor_Type)
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
            payload["alertConfig"].get("minDelaySec", 0), payload["alertConfig"].get("maxDelaySec", 0),
            payload.get("kmlProbabilities", {}), payload.get("deviceAlertMapping", {}),
            payload.get("deviceDomainMapping", {}),
            payload.get("deviceSwarmMode", {}), 
            payload.get("deviceSwarmSize", {}),
            payload.get("deviceSwarmArc", {}),
            # --- ADDITIVE BATCH ARGUMENTS ---
            payload["alertConfig"].get("enableBatchMode", False),
            payload["alertConfig"].get("batchSize", 50),
            payload["alertConfig"].get("batchIntervalSec", 5.0)
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

# ZERO-HARDCODE GEOMETRY EXPORTER
def compile_kml_and_csv(report_name: str, alerts: list, devices: list):
    csv_io = StringIO()
    writer = csv.writer(csv_io)
    writer.writerow(["sensor_type", "sensor_name", "alert_id", "priority", "latitude", "longitude", "distance_m", "bearing", "timestamp"])
    for alert in alerts:
        writer.writerow([alert["sensor_type"], alert["sensor_name"], alert["alert_id"], alert["priority"], alert.get("latitude", 0), alert.get("longitude", 0), alert.get("distance_m", 0), alert.get("bearing", 0), alert["timestamp"]])
    
    kml = f'<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n    <name>{report_name}</name>\n    <Style id="omniStyle"><IconStyle><color>ff0000ff</color><scale>1.4</scale></IconStyle></Style>\n    <Style id="directionalStyle"><IconStyle><color>ffff0000</color><scale>1.4</scale></IconStyle></Style>\n    <Style id="alertHigh"><IconStyle><color>ff0000ff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="alertMedium"><IconStyle><color>ff00ffff</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="alertLow"><IconStyle><color>ff00ff00</color><scale>1.2</scale></IconStyle></Style>\n    <Style id="pidsAlertStyle"><IconStyle><color>ffffff00</color><scale>1.3</scale></IconStyle></Style>\n'
    
    for dev in devices:
        clean_type = str(dev.get("type", "")).upper()
        dev_id = dev.get("id", "Unknown")
        lat = float(dev.get("lat", 0.0))
        lng = float(dev.get("lng", 0.0))
        polygon = dev.get("polygon", [])
        fov = float(dev.get("fov", 360.0))
        outerRange = float(dev.get("outerRange", 100.0))
        innerRange = float(dev.get("innerRange", 0.0))
        
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
            style = "#directionalStyle" if fov < 360 else "#omniStyle"
            kml += f'<Placemark><name>{dev_id}</name><styleUrl>{style}</styleUrl><Point><coordinates>{lng},{lat},0</coordinates></Point></Placemark>'
            
            if fov < 360:
                azimuth = float(dev.get("azimuth", 0.0))
                start_bearing = (azimuth - (fov / 2)) % 360
                end_bearing = (azimuth + (fov / 2)) % 360
                arc_points = []
                angle = start_bearing
                while True:
                    pt_lat, pt_lng = fast_destination(lat, lng, outerRange, angle)
                    arc_points.append(f"{pt_lng},{pt_lat},0")
                    angle = (angle + 2) % 360
                    if abs((angle - end_bearing + 360) % 360) < 2: break
                kml += f'<Placemark><name>{dev_id} FOV</name><Style><LineStyle><color>66ff0000</color><width>1</width></LineStyle><PolyStyle><color>2200ff00</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>{lng},{lat},0 {" ".join(arc_points)} {lng},{lat},0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>'
            else:
                outer_pts, inner_pts = [], []
                for angle in range(361):
                    opt_lat, opt_lng = fast_destination(lat, lng, outerRange, angle)
                    outer_pts.append(f"{opt_lng},{opt_lat},0")
                    if innerRange > 0:
                        ipt_lat, ipt_lng = fast_destination(lat, lng, innerRange, angle)
                        inner_pts.append(f"{ipt_lng},{ipt_lat},0")
                kml += f'<Placemark><name>{dev_id} Boundary</name><LineString><coordinates>{" ".join(outer_pts)}</coordinates></LineString></Placemark>'
                if innerRange > 0:
                    kml += f'<Placemark><name>{dev_id} Exclusion</name><LineString><coordinates>{" ".join(inner_pts)}</coordinates></LineString></Placemark>'

    for alert in alerts:
        clean_type = str(alert["sensor_type"]).upper()
        if "PIDS" in clean_type: style = "#pidsAlertStyle"
        else: style = "#alertHigh" if alert["priority"] == "HIGH" else "#alertMedium" if alert["priority"] == "MEDIUM" else "#alertLow"
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
            "deviceAlertMapping": json.loads(getattr(s, 'devicealertmapping', '{}')) if getattr(s, 'devicealertmapping', None) else {},
            "deviceDomainMapping": json.loads(getattr(s, 'devicedomainmapping', '{}')) if getattr(s, 'devicedomainmapping', None) else {},
            # --- NEW SWARM CONTROLS ---
            "deviceSwarmMode": json.loads(getattr(s, 'deviceswarmmode', '{}')) if getattr(s, 'deviceswarmmode', None) else {},
            "deviceSwarmSize": json.loads(getattr(s, 'deviceswarmsize', '{}')) if getattr(s, 'deviceswarmsize', None) else {},
            "deviceSwarmArc": json.loads(getattr(s, 'deviceswarmarc', '{}')) if getattr(s, 'deviceswarmarc', None) else {}
        }
    
    # Fallback if no scenario exists for this workspace yet
    return { 
        "name": f"{workspace_name} Mission", 
        "activeDevices": [], 
        "udpIp": "127.0.0.1", 
        "udpPort": 5005, 
        "workspace": workspace_name, 
        "kmlProbabilities": {}, 
        "deviceAlertMapping": {}, 
        "deviceDomainMapping": {},
        "deviceSwarmMode": {},
        "deviceSwarmSize": {},
        "deviceSwarmArc": {}
    }

@app.post("/api/state/scenario")
def save_scenario_state(payload: ScenarioModel, db: Session = Depends(get_db)):
    import uuid
    target_workspace = payload.workspace or "Default"
    
    dev_str = json.dumps(payload.activeDevices) if payload.activeDevices else "[]"
    prob_str = json.dumps(payload.kmlProbabilities) if payload.kmlProbabilities else "{}"
    map_str = json.dumps(getattr(payload, 'deviceAlertMapping', {}) or {})
    domain_str = json.dumps(getattr(payload, 'deviceDomainMapping', {}) or {})
    swarm_mode_str = json.dumps(getattr(payload, 'deviceSwarmMode', {}) or {})
    swarm_size_str = json.dumps(getattr(payload, 'deviceSwarmSize', {}) or {})
    swarm_arc_str = json.dumps(getattr(payload, 'deviceSwarmArc', {}) or {})

    # OPTIMIZATION: Only query the DB if we already have an ID (Updating)
    if payload.id:
        existing = db.query(ScenarioStateDB).filter(ScenarioStateDB.id == payload.id).first()
        if existing:
            existing.name = payload.name
            existing.activeDevices = dev_str
            existing.udpIp = payload.udpIp
            existing.udpPort = payload.udpPort
            existing.workspace = target_workspace
            existing.kmlProbabilities = prob_str
            existing.deviceAlertMapping = map_str
            existing.deviceDomainMapping = domain_str
            existing.deviceSwarmMode = swarm_mode_str
            existing.deviceSwarmSize = swarm_size_str
            existing.deviceSwarmArc = swarm_arc_str
            db.commit()
            return {"status": "success", "id": payload.id}
    
    # OPTIMIZATION: Instantly inject new drafts without scanning the DB first
    new_id = payload.id if payload.id else str(uuid.uuid4())
    new_s = ScenarioStateDB(
        id=new_id, 
        name=payload.name, 
        activeDevices=dev_str, 
        udpIp=payload.udpIp, 
        udpPort=payload.udpPort, 
        workspace=target_workspace,
        kmlProbabilities=prob_str,
        deviceAlertMapping=map_str,
        deviceDomainMapping=domain_str,
        deviceSwarmMode=swarm_mode_str,
        deviceSwarmSize=swarm_size_str,
        deviceSwarmArc=swarm_arc_str
    )
    db.add(new_s)
    db.commit()
    
    return {"status": "success", "id": new_id}
@app.get("/api/workspaces")
def get_all_workspaces(db: Session = Depends(get_db)):
    try:
        # Ask PostgreSQL for all unique workspace names currently saved in scenarios
        scenario_ws = [row[0] for row in db.query(ScenarioStateDB.workspace).distinct().all() if row[0]]
        
        # Deduplicate and ensure 'Default' is always in the list
        unique_workspaces = list(set(["Default"] + scenario_ws))
        
        return {"status": "success", "workspaces": unique_workspaces}
    except Exception as e:
        print(f"Error fetching workspaces: {e}")
        return {"status": "error", "workspaces": ["Default"]}
@app.get("/api/state/scenarios/{workspace}")
def get_workspace_scenarios(workspace: str, db: Session = Depends(get_db)):
    scenarios = db.query(ScenarioStateDB).filter(ScenarioStateDB.workspace == workspace).all()
    res = []
    for s in scenarios:
        res.append({
            "id": s.id,
            "name": s.name,
            "workspace": s.workspace,
            "activeDevices": json.loads(s.activeDevices) if s.activeDevices else [],
            "udpIp": s.udpIp,
            "udpPort": s.udpPort,
            "kmlProbabilities": json.loads(s.kmlProbabilities) if s.kmlProbabilities else {},
            
            # --- THE FIX: We can now fetch these naturally because database.py knows they exist ---
            "deviceAlertMapping": json.loads(s.deviceAlertMapping) if s.deviceAlertMapping else {},
            "deviceDomainMapping": json.loads(s.deviceDomainMapping) if s.deviceDomainMapping else {},
            "deviceSwarmMode": json.loads(s.deviceSwarmMode) if s.deviceSwarmMode else {},
            "deviceSwarmSize": json.loads(s.deviceSwarmSize) if s.deviceSwarmSize else {},
            "deviceSwarmArc": json.loads(s.deviceSwarmArc) if s.deviceSwarmArc else {}
        })
    return res