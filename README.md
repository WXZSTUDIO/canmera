# canmera · 飓风相机 Web PWA

把 iOS「飓风相机（影视飓风 · 实时电影感 Log 拍摄）」复刻的网页版 PWA。

- 摄像头实时取流 → WebGL 实时套 6 套电影感影调
- 拍照 / 录影 / 本地图片套影调 / 一键分享
- 纯静态 ES Modules，无需构建；manifest + service worker 离线壳

## 运行
```
python3 -m http.server 8123
# 打开 http://localhost:8123 （摄像头/真机需 localhost 或 HTTPS）
```
