export const FIXED_LEFT_ITEMS = [
  {
    id: 'speed',
    label: '속도',
    unit: 'km/h',
    match: (topic, data) =>
      data?.sensor_info?.type === 'speed' || topic.includes('speed'),
  },
  {
    id: 'rpm',
    label: 'RPM',
    unit: 'rpm',
    match: (topic, data) =>
      data?.sensor_info?.type === 'rpm' || topic.includes('rpm'),
  },
  {
    id: 'gear',
    label: '기어',
    unit: '',
    match: (topic, data) =>
      data?.sensor_info?.type === 'gear' || topic.includes('gear'),
  },
  {
    id: 'throttle',
    label: '스로틀',
    unit: '%',
    match: (topic, data) =>
      data?.sensor_info?.type === 'throttle' || topic.includes('throttle'),
  },
  {
    id: 'brake',
    label: '브레이크',
    unit: '%',
    match: (topic, data) =>
      data?.sensor_info?.type === 'brake' || topic.includes('brake'),
  },
  {
    id: 'steering',
    label: '조향각',
    unit: '°',
    match: (topic, data) =>
      data?.sensor_info?.type === 'angle' || topic.includes('steering'),
  },
  {
    id: 'torque',
    label: '토크',
    unit: 'Nm',
    match: (topic, data) =>
      data?.sensor_info?.type === 'torque' || topic.includes('torque'),
  },
]

export const FIXED_RIGHT_ITEMS = [
  {
    id: 'battery',
    label: '배터리',
    unit: '%',
    match: (topic, data) =>
      data?.sensor_info?.type === 'battery' || topic.includes('battery'),
  },
  {
    id: 'voltage',
    label: '전압',
    unit: 'V',
    match: (topic, data) =>
      data?.sensor_info?.type === 'voltage' || topic.includes('voltage'),
  },
  {
    id: 'current',
    label: '전류',
    unit: 'A',
    match: (topic, data) =>
      data?.sensor_info?.type === 'current' || topic.includes('current'),
  },
  {
    id: 'temperature',
    label: '온도',
    unit: '°C',
    match: (topic, data) =>
      data?.sensor_info?.type === 'temperature' || topic.includes('temp'),
  },
  {
    id: 'pressure',
    label: '압력',
    unit: 'bar',
    match: (topic, data) =>
      data?.sensor_info?.type === 'pressure' || topic.includes('pressure'),
  },
]

export const FIXED_GPS_ITEMS = [
  {
    id: 'gps_lat',
    label: 'GPS 위도',
    unit: '',
    value: (gps) => (gps ? gps.lat.toFixed(6) : '--'),
  },
  {
    id: 'gps_lon',
    label: 'GPS 경도',
    unit: '',
    value: (gps) => (gps ? gps.lon.toFixed(6) : '--'),
  },
]
