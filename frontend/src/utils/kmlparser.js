/**
 * kmlParser.js
 * Parses multiple KML files independently, assigns deterministic layer styles,
 * and extracts lightweight coordinate primitives to prevent memory regressions.
 */

const LAYER_PALETTE = [
    { fill: '#e6194b', line: '#800000', opacity: 0.4 }, // Red
    { fill: '#3cb44b', line: '#008000', opacity: 0.4 }, // Green
    { fill: '#4363d8', line: '#000080', opacity: 0.4 }, // Blue
    { fill: '#f58231', line: '#804000', opacity: 0.4 }, // Orange
    { fill: '#911eb4', line: '#4b0082', opacity: 0.4 }, // Purple
    { fill: '#ffe119', line: '#808000', opacity: 0.4 }  // Yellow
];

export class MultiFileKMLParser {
    constructor() {
        this.parsedLayers = new Map();
    }

    /**
     * Parses raw KML text into lightweight feature collections isolated by file name.
     * @param {string} fileName - Unique identifier for the file (e.g., 'Buildings.kmz')
     * @param {string} rawKmlText - The raw XML/KML string content
     * @param {number} fileIndex - Index used to assign a deterministic color palette
     */
    parseAndIsolate(fileName, rawKmlText, fileIndex) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(rawKmlText, 'text/xml');
        const styleTheme = LAYER_PALETTE[fileIndex % LAYER_PALETTE.length];

        const placemarks = xmlDoc.getElementsByTagName('Placemark');
        const lightweightFeatures = [];

        for (let i = 0; i < placemarks.length; i++) {
            const placemark = placemarks[i];
            const nameNode = placemark.getElementsByTagName('name')[0];
            const featureName = nameNode ? nameNode.textContent.trim() : `Feature_${i}`;

            // Extract coordinates directly into memory-efficient Float32Arrays / plain number arrays
            // This drops the XML DOM nodes completely out of scope so Garbage Collection can reclaim them.
            const coordsNode = placemark.getElementsByTagName('coordinates')[0];
            if (!coordsNode) continue;

            const rawCoordsString = coordsNode.textContent.trim();
            const parsedCoordinates = this.#extractNumericCoordinates(rawCoordsString);

            // Determine geometry type
            const isPolygon = placemark.getElementsByTagName('Polygon').length > 0;
            const geometryType = isPolygon ? 'Polygon' : 'LineString';

            lightweightFeatures.push({
                id: `${fileName}_feature_${i}`,
                name: featureName,
                layerId: fileName,
                geometryType: geometryType,
                // Store lightweight numeric arrays only
                coordinates: parsedCoordinates,
                // Assign isolated, deterministic styles directly to the feature
                style: {
                    fillColor: styleTheme.fill,
                    lineColor: styleTheme.line,
                    fillOpacity: styleTheme.opacity,
                    lineWidth: 2
                }
            });
        }

        // Store layer cleanly isolated from other files
        this.parsedLayers.set(fileName, {
            layerId: fileName,
            theme: styleTheme,
            featureCount: lightweightFeatures.length,
            features: lightweightFeatures
        });

        return this.parsedLayers.get(fileName);
    }

    /**
     * Converts raw KML coordinate string directly to a lightweight 2D number array.
     * Prevents keeping massive comma-separated strings in memory.
     */
    #extractNumericCoordinates(coordString) {
        const points = coordString.split(/\s+/);
        const result = [];
        for (let i = 0; i < points.length; i++) {
            if (!points[i]) continue;
            const parts = points[i].split(',');
            if (parts.length >= 2) {
                // Parse Float explicitly to save memory and prepare for WebGL/Canvas rendering
                result.push([parseFloat(parts[0]), parseFloat(parts[1])]);
            }
        }
        return result;
    }

    getLayer(fileName) {
        return this.parsedLayers.get(fileName);
    }

    getAllLayers() {
        return Array.from(this.parsedLayers.values());
    }
}