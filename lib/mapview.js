/**
 * 「地图选点」组件（页面与会话 Tab 共用一份源码）。
 *
 * 输出 MAP_SRC：一段浏览器端脚本，执行后挂到 window.__apMap。
 * 页面直接内联；会话 Tab 由 tools/sync-sky-renderer.mjs 同步到 lib/client.js 的标记之间。
 *
 * 交互约定：
 *   - 只有**按下后没移动就松开**才算选点；按下后移动 = 拖动地图（阈值 4px）
 *   - 点中站点圆点（12px 内）→ 选中该站点，高亮 + 显示地名，地图不关闭
 *   - 点空白 → 自定义候选点（十字 + 经纬度），可填波特尔/名称
 *   - 点「确定」才回调 onConfirm 并关闭；「关闭」/ Esc 放弃
 *
 * 依赖后端：GET /astro-plan/api/tile/topo/{z}/{x}/{y}、GET /astro-plan/api/geo（离线兜底）
 */

export const MAP_SRC = String.raw`
window.__apMap = (function () {
  var TILE = 256
  var DRAG_THRESHOLD = 4      // 按下后位移超过 4px 视为拖动
  var HIT_RADIUS = 12         // 站点命中半径（px）

  function lon2x(lon, z) { return (lon + 180) / 360 * Math.pow(2, z) * TILE }
  function lat2y(lat, z) {
    var r = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z) * TILE
  }
  function x2lon(x, z) { return x / (Math.pow(2, z) * TILE) * 360 - 180 }
  function y2lat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / (Math.pow(2, z) * TILE)
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  }
  function distKm(a, b) {
    var R = 6371
    var dLat = (b.lat - a.lat) * Math.PI / 180
    var dLon = (b.lon - a.lon) * Math.PI / 180
    var la1 = a.lat * Math.PI / 180
    var la2 = b.lat * Math.PI / 180
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
  }

  function mount(host, opts) {
    var o = opts || {}
    var state = {
      z: o.zoom || 5,
      center: { lat: o.lat || 35, lon: o.lon || 105 },
      picked: o.picked || null,
      bortle: (o.picked && o.picked.bortle) || 4,
      name: (o.picked && o.picked.name) || '',
      origin: o.origin || null,
      sites: o.sites || [],
      offline: null,
      tileFail: 0,
      tileOk: 0,
    }
    var tiles = {}
    var gesture = null

    var root = document.createElement('div')
    root.className = 'ap-map'
    root.innerHTML =
      '<div class="ap-map-bar">' +
        '<span class="ap-map-title">点击地图上的站点直接选中；拖动平移，滚轮缩放</span>' +
        '<button type="button" class="ap-map-close">关闭</button>' +
      '</div>' +
      '<div class="ap-map-canvas"><canvas></canvas>' +
        '<div class="ap-map-attrib">© Esri, HERE, Garmin, USGS · 瓦片经本地代理</div>' +
        '<div class="ap-map-pick-label" hidden></div>' +
      '</div>' +
      '<div class="ap-map-read">' +
        '<span class="ap-map-pick">未选择</span>' +
        '<label class="ap-map-bortle-wrap" hidden>波特尔 <input class="ap-map-bortle" type="number" min="1" max="9" value="' + state.bortle + '" /></label>' +
        '<label class="ap-map-name-wrap" hidden>名称 <input class="ap-map-name" maxlength="24" placeholder="可选" /></label>' +
        '<span class="ap-map-dist">—</span>' +
        '<button type="button" class="ap-map-ok">确定</button>' +
      '</div>'
    host.innerHTML = ''
    host.appendChild(root)

    var canvas = root.querySelector('canvas')
    var ctx = canvas.getContext('2d')
    var labelBox = root.querySelector('.ap-map-pick-label')
    var readPick = root.querySelector('.ap-map-pick')
    var readDist = root.querySelector('.ap-map-dist')
    var bortleWrap = root.querySelector('.ap-map-bortle-wrap')
    var nameWrap = root.querySelector('.ap-map-name-wrap')

    function size() {
      var box = root.querySelector('.ap-map-canvas')
      var dpr = Math.min(2, window.devicePixelRatio || 1)
      var w = Math.max(320, box.clientWidth)
      var h = Math.max(240, box.clientHeight)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return { w: w, h: h }
    }

    function frame() {
      var s = size()
      return {
        w: s.w, h: s.h,
        x0: lon2x(state.center.lon, state.z) - s.w / 2,
        y0: lat2y(state.center.lat, state.z) - s.h / 2,
      }
    }

    function pixOf(lat, lon, view) {
      return { x: lon2x(lon, state.z) - view.x0, y: lat2y(lat, state.z) - view.y0 }
    }

    function draw() {
      var view = frame()
      ctx.clearRect(0, 0, view.w, view.h)
      ctx.fillStyle = '#0b1220'
      ctx.fillRect(0, 0, view.w, view.h)

      var n = Math.pow(2, state.z)
      var tx0 = Math.floor(view.x0 / TILE)
      var ty0 = Math.floor(view.y0 / TILE)
      var tx1 = Math.floor((view.x0 + view.w) / TILE)
      var ty1 = Math.floor((view.y0 + view.h) / TILE)
      if (!state.offline) {
        for (var tx = tx0; tx <= tx1; tx++) {
          for (var ty = ty0; ty <= ty1; ty++) {
            if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue
            var key = 'topo/' + state.z + '/' + tx + '/' + ty
            var img = tiles[key]
            if (!img) {
              img = new Image()
              img.onload = function () { state.tileOk++; draw() }
              img.onerror = function () { state.tileFail++; if (state.tileFail > 4 && state.tileOk === 0) { state.offline = true; draw() } }
              img.src = '/astro-plan/api/tile/topo/' + state.z + '/' + tx + '/' + ty
              tiles[key] = img
            }
            if (img.complete && img.naturalWidth) {
              ctx.drawImage(img, tx * TILE - view.x0, ty * TILE - view.y0, TILE, TILE)
            }
          }
        }
      } else {
        drawOffline(view)
      }

      // 站点圆点
      var pickedSite = state.picked && state.picked.kind === 'site' ? state.picked : null
      for (var i = 0; i < state.sites.length; i++) {
        var site = state.sites[i]
        var p = pixOf(site.lat, site.lon, view)
        if (p.x < -12 || p.y < -12 || p.x > view.w + 12 || p.y > view.h + 12) continue
        var active = pickedSite && pickedSite.siteId === site.id
        ctx.beginPath()
        ctx.arc(p.x, p.y, active ? 6 : 3, 0, Math.PI * 2)
        ctx.fillStyle = active ? 'rgba(255,212,121,0.95)' : 'rgba(110,168,254,0.9)'
        ctx.fill()
        if (active) {
          ctx.strokeStyle = '#ffd479'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(p.x, p.y, 10, 0, Math.PI * 2)
          ctx.stroke()
        }
      }

      // 出发地 + 虚线 + 距离
      var target = pickedLatLon()
      if (state.origin && target) {
        var op = pixOf(state.origin.lat, state.origin.lon, view)
        var cp = pixOf(target.lat, target.lon, view)
        ctx.save()
        ctx.strokeStyle = 'rgba(240,200,120,0.85)'
        ctx.lineWidth = 1.5
        ctx.setLineDash([5, 5])
        ctx.beginPath(); ctx.moveTo(cp.x, cp.y); ctx.lineTo(op.x, op.y); ctx.stroke()
        ctx.restore()
        ctx.fillStyle = '#f0c878'
        ctx.beginPath(); ctx.arc(op.x, op.y, 5.5, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = '#2a2110'
        ctx.font = '10px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('⌂', op.x, op.y + 3.5)
        var km = distKm(target, state.origin)
        readDist.textContent = '出发地 ' + (state.origin.label || '出发地') + ' · 直线 ' + km.toFixed(0) + ' km（车程约 ' + Math.round(km * 1.2) + '–' + Math.round(km * 1.6) + ' km）'
      } else {
        readDist.textContent = state.origin ? '选择一个地点后显示到出发地的距离' : '未设置出发地'
      }

      // 自定义候选点十字
      if (state.picked && state.picked.kind === 'point' && target) {
        var px = pixOf(target.lat, target.lon, view)
        ctx.strokeStyle = '#ffd479'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(px.x - 9, px.y); ctx.lineTo(px.x - 3, px.y)
        ctx.moveTo(px.x + 3, px.y); ctx.lineTo(px.x + 9, px.y)
        ctx.moveTo(px.x, px.y - 9); ctx.lineTo(px.x, px.y - 3)
        ctx.moveTo(px.x, px.y + 3); ctx.lineTo(px.x, px.y + 9)
        ctx.stroke()
      }

      syncReadout(view)
    }

    function drawOffline(view) {
      var geo = state.offline
      if (geo === true) {
        fetch('/astro-plan/api/geo').then(function (r) { return r.json() }).then(function (d) {
          state.offline = d
          draw()
        }).catch(function () { state.offline = { provinces: [] } })
        return
      }
      if (!geo || !geo.provinces) return
      ctx.strokeStyle = 'rgba(140,170,210,0.55)'
      ctx.lineWidth = 1
      for (var p = 0; p < geo.provinces.length; p++) {
        var rings = geo.provinces[p].rings
        for (var r2 = 0; r2 < rings.length; r2++) {
          var ring = rings[r2]
          ctx.beginPath()
          for (var i = 0; i < ring.length; i++) {
            var x = lon2x(ring[i][0], state.z) - view.x0
            var y = lat2y(ring[i][1], state.z) - view.y0
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
          }
          ctx.stroke()
        }
      }
    }

    function pickedLatLon() {
      var picked = state.picked
      if (!picked) return null
      if (picked.kind === 'site') {
        for (var i = 0; i < state.sites.length; i++) {
          if (state.sites[i].id === picked.siteId) return { lat: state.sites[i].lat, lon: state.sites[i].lon }
        }
        return null
      }
      return { lat: picked.lat, lon: picked.lon }
    }

    function syncReadout(view) {
      var picked = state.picked
      labelBox.hidden = true
      if (!picked) { readPick.textContent = '未选择'; bortleWrap.hidden = true; nameWrap.hidden = true; return }
      if (picked.kind === 'site') {
        var site = null
        for (var i = 0; i < state.sites.length; i++) if (state.sites[i].id === picked.siteId) site = state.sites[i]
        readPick.textContent = site ? (site.name + ' · ' + site.province + ' · 波特尔 ' + site.bortle) : '站点'
        bortleWrap.hidden = true
        nameWrap.hidden = true
        if (site && view) {
          var sp = pixOf(site.lat, site.lon, view)
          labelBox.hidden = false
          labelBox.textContent = site.name
          labelBox.style.left = Math.round(sp.x + 12) + 'px'
          labelBox.style.top = Math.round(sp.y - 10) + 'px'
        }
      } else {
        readPick.textContent = picked.lat.toFixed(3) + ', ' + picked.lon.toFixed(3) + ' · z' + state.z
        bortleWrap.hidden = false
        nameWrap.hidden = false
      }
    }

    function hitTest(px, py) {
      var view = frame()
      var best = null
      var bestDist = HIT_RADIUS * HIT_RADIUS
      for (var i = 0; i < state.sites.length; i++) {
        var site = state.sites[i]
        var p = pixOf(site.lat, site.lon, view)
        var dx = p.x - px
        var dy = p.y - py
        var d2 = dx * dx + dy * dy
        if (d2 <= bestDist) { bestDist = d2; best = site }
      }
      return best
    }

    function toLatLon(px, py) {
      var view = frame()
      return { lon: x2lon(view.x0 + px, state.z), lat: y2lat(view.y0 + py, state.z) }
    }

    function selectAt(px, py) {
      var site = hitTest(px, py)
      if (site) {
        state.picked = { kind: 'site', siteId: site.id, name: site.name }
        state.name = site.name
      } else {
        var point = toLatLon(px, py)
        state.picked = { kind: 'point', lat: Math.round(point.lat * 1000) / 1000, lon: Math.round(point.lon * 1000) / 1000 }
        state.bortle = state.bortle || 4
      }
      draw()
    }

    // —— 手势：按下–移动–松开 ——
    canvas.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return
      var rect = canvas.getBoundingClientRect()
      gesture = {
        startX: e.clientX, startY: e.clientY,
        lastX: e.clientX, lastY: e.clientY,
        startLon: state.center.lon, startLat: state.center.lat,
        dragging: false, pointerId: e.pointerId,
        offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
      }
      try { canvas.setPointerCapture(e.pointerId) } catch (err) { /* 忽略 */ }
      canvas.style.cursor = 'grabbing'
    })

    canvas.addEventListener('pointermove', function (e) {
      if (!gesture) return
      var dx = e.clientX - gesture.startX
      var dy = e.clientY - gesture.startY
      if (!gesture.dragging && Math.abs(dx) + Math.abs(dy) <= DRAG_THRESHOLD) return
      gesture.dragging = true
      var originX = lon2x(gesture.startLon, state.z) - dx
      var originY = lat2y(gesture.startLat, state.z) - dy
      state.center.lon = x2lon(originX, state.z)
      state.center.lat = y2lat(originY, state.z)
      draw()
    })

    canvas.addEventListener('pointerup', function (e) {
      if (!gesture) return
      var dragged = gesture.dragging
      var fallbackX = gesture.offsetX
      var fallbackY = gesture.offsetY
      gesture = null
      canvas.style.cursor = 'grab'
      if (dragged) return          // 拖动结束：不算选点
      // 没移动就松开 → 选点
      var rect = canvas.getBoundingClientRect()
      var px = Number.isFinite(e.clientX) ? e.clientX - rect.left : fallbackX
      var py = Number.isFinite(e.clientY) ? e.clientY - rect.top : fallbackY
      selectAt(px, py)
    })

    canvas.addEventListener('pointercancel', function () {
      gesture = null
      canvas.style.cursor = 'grab'
    })

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault()
      state.z = Math.max(3, Math.min(17, state.z + (e.deltaY > 0 ? -1 : 1)))
      draw()
    }, { passive: false })

    root.querySelector('.ap-map-bortle').addEventListener('input', function (e) {
      state.bortle = Math.max(1, Math.min(9, Number(e.target.value) || 4))
    })
    root.querySelector('.ap-map-name').addEventListener('input', function (e) { state.name = e.target.value })

    root.querySelector('.ap-map-ok').addEventListener('click', function () {
      var picked = state.picked
      if (!picked) { if (o.onClose) o.onClose(); return }
      if (picked.kind === 'site') {
        var site = null
        for (var i = 0; i < state.sites.length; i++) if (state.sites[i].id === picked.siteId) site = state.sites[i]
        if (o.onConfirm) o.onConfirm({ kind: 'site', siteId: picked.siteId, name: site ? site.name : picked.name })
        return
      }
      if (o.onConfirm) o.onConfirm({
        kind: 'point',
        lat: Math.round(picked.lat * 1000) / 1000,
        lon: Math.round(picked.lon * 1000) / 1000,
        bortle: state.bortle,
        name: (state.name || '').trim(),
      })
    })
    root.querySelector('.ap-map-close').addEventListener('click', function () {
      if (o.onClose) o.onClose()
    })
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); if (o.onClose) o.onClose() }
    })

    setTimeout(draw, 30)
    setTimeout(draw, 260)
    if (window.ResizeObserver) { new ResizeObserver(draw).observe(root) }

    state.picked = state.picked || null
    return {
      focus: function (lat, lon, zoom) {
        if (Number.isFinite(lat)) state.center.lat = lat
        if (Number.isFinite(lon)) state.center.lon = lon
        if (zoom) state.z = Math.max(3, Math.min(17, zoom))
        draw()
      },
      getPicked: function () { return state.picked },
      destroy: function () { host.innerHTML = '' },
    }
  }

  return { mount: mount, DRAG_THRESHOLD: DRAG_THRESHOLD, HIT_RADIUS: HIT_RADIUS }
})()
`
