def simulation_worker(scenarioName, udpIp, udpPort, active_devices, env_devices, schemas, minDelay, maxDelay, kml_probs, device_alert_mapping, device_domain_mapping, device_swarm_mode, device_swarm_size):
    global engine_state
    
    try:
        # 1. PRE-FLIGHT INDEXING MUST HAPPEN FIRST!
        polygons, lines = build_spatial_indices(env_devices)
        device_target_cache = precompute_device_targets(active_devices, polygons, lines)

        if kml_probs:
            total_prob_sum = sum(float(p) for p in kml_probs.values())
            if total_prob_sum > 1.0:
                kml_probs = {k: (float(v) / total_prob_sum) for k, v in kml_probs.items()}

        task_pool = []
        total_alerts_requested = 0

        for dev_dict in active_devices:
            dev_total = int(dev_dict.get('alertCount', 0))
            if dev_total <= 0: continue
            total_alerts_requested += dev_total
            
            d_obj = OptimizedDevice(dev_dict)
            is_swarm = device_swarm_mode.get(d_obj.id, False)
            
            if is_swarm:
                swarm_size = int(device_swarm_size.get(d_obj.id, 5))
                packets_per_drone = max(1, dev_total // swarm_size)
                
                target_lat, target_lng = d_obj.lat, d_obj.lng 
                sensor_cache = device_target_cache.get(d_obj.id, {})
                found_target = False
                
                for p_dict in [sensor_cache.get("polygons", {}), sensor_cache.get("lines", {})]:
                    for fname, items in p_dict.items():
                        if "PERIMETER" in fname and items:
                            target_lat, target_lng = items[0]["rep_point"]
                            found_target = True
                            break
                    if found_target: break
                    
                if not found_target and sensor_cache.get("polygons"):
                    first_key = list(sensor_cache["polygons"].keys())[0]
                    if sensor_cache["polygons"][first_key]:
                        target_lat, target_lng = sensor_cache["polygons"][first_key][0]["rep_point"]

                # --- NEW CONVERGING SWARM PATTERN ---
                if d_obj.fov < 360:
                    base_angle = d_obj.azimuth
                    arc_spread = d_obj.fov * 0.80  # 80% of camera vision cone
                else:
                    base_angle = random.uniform(0, 360)
                    arc_spread = 45  
                    
                spawn_distance = d_obj.outerRange - random.uniform(20, 1500)

                drones = []
                for i in range(swarm_size):
                    if swarm_size > 1:
                        angle_offset = (i / (swarm_size - 1)) * arc_spread - (arc_spread / 2)
                    else:
                        angle_offset = 0
                        
                    drone_spawn_angle = (base_angle + angle_offset) % 360
                    
                    start_lat, start_lng = fast_destination(d_obj.lat, d_obj.lng, spawn_distance, drone_spawn_angle)
                    
                    end_spread = random.uniform(30, 50)
                    end_angle = random.uniform(0, 360)
                    end_lat, end_lng = fast_destination(target_lat, target_lng, end_spread, end_angle)
                    
                    drones.append({
                        "track_id": 1001 + i,
                        "start": (start_lat, start_lng),
                        "end": (end_lat, end_lng),
                        "speed": round(random.uniform(40, 100), 2),
                        "height": round(random.uniform(50, 200), 2),
                        "total_steps": packets_per_drone,
                        "current_step": 0
                    })
                # ------------------------------------
                    
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
                fraction = drone["current_step"] / max(1, drone["total_steps"])
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
        # --- THE FAILSAFE: NEVER LOCK THE UI ON A FATAL ERROR ---
        print(f"\n[CRITICAL ENGINE FAULT]: {e}\n")
        with engine_lock:
            engine_state['logs'].insert(0, {"time": datetime.now().strftime("%H:%M:%S"), "msg": f"CRITICAL ENGINE FAULT: {str(e)}. Review terminal for details.", "type": "error"})
            
    finally:
        # ALWAYS ENSURE THE SYSTEM UNLOCKS NO MATTER WHAT HAPPENS
        with engine_lock:
            engine_state['is_running'] = False
