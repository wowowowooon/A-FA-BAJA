import L from 'leaflet'

// CARTO basemaps는 API 키 없이는 "API KEY REQUIRED" 타일을 반환하므로 키가 필요 없는 타일 사용
// - 다크: OpenStreetMap 표준 타일(z19까지 상세)에 CSS 필터로 다크 테마 적용
// - 위성: Esri World Imagery (z19까지, 오프로드 코스 확인용)
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const SATELLITE_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

const MAX_ZOOM = 20

export function addDarkTileLayer(map) {
  const dark = L.tileLayer(OSM_TILE_URL, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    className: 'race-tiles-dark',
    maxNativeZoom: 19,
    maxZoom: MAX_ZOOM,
  })
  const satellite = L.tileLayer(SATELLITE_TILE_URL, {
    attribution: 'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics',
    className: 'race-tiles-satellite',
    maxNativeZoom: 19,
    maxZoom: MAX_ZOOM,
  })

  dark.addTo(map)
  L.control.layers({ 다크: dark, 위성: satellite }, null, { position: 'bottomright' }).addTo(map)
  return dark
}

export function initDarkMap(
  container,
  { center, zoom = 17, zoomControl = false, doubleClickZoom = true } = {}
) {
  const map = L.map(container, {
    center,
    zoom,
    zoomControl,
    preferCanvas: true,
    zoomAnimation: true,
    doubleClickZoom,
  })
  map.getContainer().classList.add('race-dark-map')
  addDarkTileLayer(map)
  return map
}

export function createVehicleIcon(courseDeg = 0, speedKmh) {
  const rotation = Number.isFinite(courseDeg) ? courseDeg : 0
  const hasSpeed = Number.isFinite(speedKmh)
  const speedLabel = hasSpeed ? `${Math.round(speedKmh)}` : ''
  return L.divIcon({
    className: 'race-vehicle-icon',
    html: `
      <div class="race-vehicle-marker-wrap">
        ${hasSpeed ? `<div class="race-vehicle-speed">${speedLabel}</div>` : ''}
        <div class="race-vehicle-marker" style="transform: rotate(${rotation}deg)">
          <span class="race-vehicle-pulse"></span>
          <span class="race-vehicle-arrow"></span>
        </div>
      </div>
    `,
    iconSize: hasSpeed ? [48, 52] : [36, 36],
    iconAnchor: hasSpeed ? [24, 38] : [18, 18],
  })
}

export function createMeasureIcon(label) {
  return L.divIcon({
    className: 'race-measure-icon',
    html: `<div class="race-measure-marker">${label}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  })
}

export function createLapLabelIcon(lap, color) {
  const label = Number.isFinite(Number(lap)) ? `Lap ${lap}` : String(lap)
  return L.divIcon({
    className: 'race-lap-label-icon',
    html: `<div class="race-lap-label" style="--lap-color:${color}">${label}</div>`,
    iconSize: [56, 24],
    iconAnchor: [28, 12],
  })
}

export function addTrackPolylines(map, latlngs, { color, weight = 4, opacity = 0.88, isCurrent = false } = {}) {
  const glow = L.polyline(latlngs, {
    color,
    weight: weight + 8,
    opacity: isCurrent ? 0.28 : 0.18,
    lineCap: 'round',
    lineJoin: 'round',
    className: 'race-track-glow',
  }).addTo(map)

  const line = L.polyline(latlngs, {
    color,
    weight,
    opacity,
    lineCap: 'round',
    lineJoin: 'round',
    className: 'race-track-line',
  }).addTo(map)

  return [glow, line]
}
