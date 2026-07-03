# simcore-backend/alert_engine.py
import uuid
import sys

class AlertEngine:
    """
    High-performance, lightweight alert generation system for Python backends.
    Prevents 2GB+ memory bloat by storing lightweight reference dictionaries.
    """
    def __init__(self, max_queue_size: int = 50000):
        self.max_queue_size = max_queue_size
        self.alert_queue = []
        self.dropped_alerts_count = 0

    def emit_alert(self, alert_type: str, timestamp: float, layer_id: str, feature_id: str, trigger_lat: float, trigger_lon: float) -> dict:
        # Enforce backpressure to prevent out-of-memory RAM crashes
        if len(self.alert_queue) >= self.max_queue_size:
            self.alert_queue.pop(0)
            self.dropped_alerts_count += 1

        # LIGHTWEIGHT PAYLOAD (< 200 bytes per dictionary)
        alert_payload = {
            "id": uuid.uuid4().hex[:8],
            "type": alert_type,
            "ts": timestamp,
            "refLayer": layer_id,
            "refFeature": feature_id,
            "loc": [trigger_lat, trigger_lon]
        }

        self.alert_queue.append(alert_payload)
        return alert_payload

    def flush_batch(self, batch_size: int = 100) -> list:
        """Retrieves and removes a batch of alerts from memory for WebSocket broadcasting."""
        batch = self.alert_queue[:batch_size]
        del self.alert_queue[:batch_size]
        return batch

    def get_memory_stats(self) -> dict:
        return {
            "queuedAlerts": len(self.alert_queue),
            "droppedAlerts": self.dropped_alerts_count,
            "estimatedRamBytes": sys.getsizeof(self.alert_queue) + (len(self.alert_queue) * 180)
        }