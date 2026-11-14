# Sensors

센서별 펌웨어/드라이버 코드가 들어갈 자리입니다. (추가 예정)

예정 구성:
- ESP32: 4륜 리니어 변위센서 ADC 수집 → I2C 전달
- IMU (UART)
- 보조 가속도 / G-Force 센서 (I2C)
- GPS (USB)
- Teensy 4.1: ECU CAN 수신

전체 시스템 설명은 [hardware/README.md](../README.md)를 참고하세요.
