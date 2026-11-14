/**
 * 「地图选点」组件（页面与会话 Tab 共用一份源码）。
 *
 * 输出 MAP_SRC：一段浏览器端脚本，执行后挂到 window.__apMap。
 * 页面直接内联；会话 Tab 由 tools/sync-sky-renderer.mjs 同步到 lib/client.js 的标记之间。
 *
 * 依赖的后端接口：
 *   GET /astro-plan/api/tile/{topo|street}/{z}/{x}/{y}   同源瓦片（Esri 代理）
 *   GET /astro-plan/api/geo                              离线省界（瓦片不可用时兜底）
 *   GET /astro-plan/api/geocode?q=                       地点搜索
 */

export const MAP_SRC = String.raw`
window.__apMap = (function () {
  var TILE = 256
  var STYLES = { topo: '地形', street: '普通', offline: '离线' }

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
      candidate: { lat: o.lat || 35, lon: o.lon || 105 },
      bortle: o.bortle || 4,
      name: o.name || '',
      style: 'topo',
      origin: o.origin || null,
      sites: o.sites || [],
      offline: null,
      tileFail: 0,
      tileOk: 0,
    }
    var tiles = {}
    var drag = null

    var root = document.createElement('div')
    root.className = 'ap-map'
    root.innerHTML =
      '<div class="ap-map-bar">' +
        '<input class="ap-map-q" placeholder="搜索地点：冷湖 / 青海湖 / 海坨山" />' +
        '<button class="ap-map-find" type="button">搜索</button>' +
        '<span class="ap-map-style">' +
          '<button type="button" data-style="topo" class="on">地形</button>' +
          '<button type="button" data-style="street">普通</button>' +
        '</span>' +
        '<button type="button" class="ap-map-close">关闭</button>' +
      '</div>' +
      '<div class="ap-map-results"></div>' +
      '<div class="ap-map-canvas"><canvas></canvas>' +
        '<div class="ap-map-attrib">© Esri, HERE, Garmin, USGS · 瓦片经本地代理</div>' +
      '</div>' +
      '<div class="ap-map-read">' +
        '<span class="ap-map-ll">—</span>' +
        '<label>波特尔 <input class="ap-map-bortle" type="number" min="1" max="9" value="' + state.bortle + '" /></label>' +
        '<label>名称 <input class="ap-map-name" maxlength="24" placeholder="可选" /></label>' +
        '<span class="ap-map-dist">—</span>' +
        '<button type="button" class="ap-map-setorigin">把此点设为出发地</button>' +
        '<button type="button" class="ap-map-ok">确定</button>' +
      '</div>'
    host.innerHTML = ''
    host.appendChild(root)

    var canvas = root.querySelector('canvas')
    var ctx = canvas.getContext('2d')
    var resultsBox = root.querySelector('.ap-map-results')
    var readLL = root.querySelector('.ap-map-ll')
    var readDist = root.querySelector('.ap-map-dist')

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

    function originPx(view) {
      if (!state.origin) return null
      var wx = lon2x(state.origin.lon, state.z)
      var wy = lat2y(state.origin.lat, state.z)
      return { x: wx - view.x0, y: wy - view.y0 }
    }

    function draw() {
      var s = size()
      var originX = lon2x(state.center.lon, state.z) - s.w / 2
      var originY = lat2y(state.center.lat, state.z) - s.h / 2
      var view = { x0: originX, y0: originY, w: s.w, h: s.h }
      ctx.clearRect(0, 0, s.w, s.h)
      ctx.fillStyle = '#0b1220'
      ctx.fillRect(0, 0, s.w, s.h)

      if (state.style === 'offline') {
        drawOffline(ctx, view)
      } else {
        var n = Math.pow(2, state.z)
        var tx0 = Math.floor(originX / TILE)
        var ty0 = Math.floor(originY / TILE)
        var tx1 = Math.floor((originX + s.w) / TILE)
        var ty1 = Math.floor((originY + s.h) / TILE)
        for (var tx = tx0; tx <= tx1; tx++) {
          for (var ty = ty0; ty <= ty1; ty++) {
            if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue
            var key = state.style + '/' + state.z + '/' + tx + '/' + ty
            var img = tiles[key]
            if (!img) {
              img = new Image()
              img.__key = key
              img.onload = function () { draw() }
              img.onerror = function () { state.tileFail++; if (state.tileFail > 4 && state.tileOk === 0) { state.style = 'offline'; draw() } }
              img.onload = (function (im) { return function () { state.tileOk++; draw() } })(img)
              img.src = '/astro-plan/api/tile/' + state.style + '/' + state.z + '/' + tx + '/' + ty
              tiles[key] = img
            }
            if (img.complete && img.naturalWidth) {
              ctx.drawImage(img, tx * TILE - originX, ty * TILE - originY, TILE, TILE)
            }
          }
        }
      }

      // 站点圆点
      if (state.z >= 4) {
        ctx.fillStyle = 'rgba(110,168,254,0.9)'
        for (var i = 0; i < state.sites.length; i++) {
          var site = state.sites[i]
          var px = lon2x(site.lon, state.z) - originX
          var py = lat2y(site.lat, state.z) - originY
          if (px < -10 || py < -10 || px > s.w + 10 || py > s.h + 10) continue
          ctx.beginPath()
          ctx.arc(px, py, 2.6, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // 出发地 + 虚线 + 距离
      var op = originPx(view)
      var cp = { x: lon2x(state.candidate.lon, state.z) - originX, y: lat2y(state.candidate.lat, state.z) - originY }
      if (op) {
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
        ctx.fillStyle = 'rgba(0,0,0,0.6)'
        var label = (state.origin.label || '出发地')
        ctx.fillRect(op.x + 8, op.y - 8, ctx.measureText(label).width + 8, 14)
        ctx.fillStyle = '#f0c878'
        ctx.textAlign = 'left'
        ctx.fillText(label, op.x + 12, op.y + 2)
        readDist.textContent = '出发地 ' + label + ' · 直线 ' + distKm(state.candidate, state.origin).toFixed(0) + ' km（车程约 ' + Math.round(distKm(state.candidate, state.origin) * 1.2) + '–' + Math.round(distKm(state.candidate, state.origin) * 1.6) + ' km）'
      } else {
        readDist.textContent = '未设置出发地'
      }

      // 候选十字
      ctx.strokeStyle = '#ffd479'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(cp.x - 9, cp.y); ctx.lineTo(cp.x - 3, cp.y)
      ctx.moveTo(cp.x + 3, cp.y); ctx.lineTo(cp.x + 9, cp.y)
      ctx.moveTo(cp.x, cp.y - 9); ctx.lineTo(cp.x, cp.y - 3)
      ctx.moveTo(cp.x, cp.y + 3); ctx.lineTo(cp.x, cp.y + 9)
      ctx.stroke()
      ctx.beginPath(); ctx.arc(cp.x, cp.y, 3, 0, Math.PI * 2); ctx.stroke()

      readLL.textContent = state.candidate.lat.toFixed(3) + ', ' + state.candidate.lon.toFixed(3) + ' · z' + state.z
    }

    function drawOffline(ctx2, view) {
      var geo = state.offline
      if (!geo) {
        fetch('/astro-plan/api/geo').then(function (r) { return r.json() }).then(function (d) {
          state.offline = d
          draw()
        }).catch(function () {})
        return
      }
      ctx2.strokeStyle = 'rgba(140,170,210,0.55)'
      ctx2.lineWidth = 1
      for (var p = 0; p < geo.provinces.length; p++) {
        var rings = geo.provinces[p].rings
        for (var r2 = 0; r2 < rings.length; r2++) {
          var ring = rings[r2]
          ctx2.beginPath()
          for (var i = 0; i < ring.length; i++) {
            var x = lon2x(ring[i][0], state.z) - view.x0
            var y = lat2y(ring[i][1], state.z) - view.y0
            if (i === 0) ctx2.moveTo(x, y); else ctx2.lineTo(x, y)
          }
          ctx2.stroke()
        }
      }
    }

    function toLatLon(px, py) {
      var s = size()
      var originX = lon2x(state.center.lon, state.z) - s.w / 2
      var originY = lat2y(state.center.lat, state.z) - s.h / 2
      return { lon: x2lon(originX + px, state.z), lat: y2lat(originY + py, state.z) }
    }

    function focus(lat, lon, zoom) {
      if (Number.isFinite(lat)) state.candidate.lat = lat
      if (Number.isFinite(lon)) state.candidate.lon = lon
      state.center.lat = state.candidate.lat
      state.center.lon = state.candidate.lon
      if (zoom) state.z = Math.max(3, Math.min(17, zoom))
      draw()
    }

    canvas.addEventListener('mousedown', function (e) {
      drag = { x: e.offsetX, y: e.offsetY, moved: false, lon: state.center.lon, lat: state.center.lat }
    })
    window.addEventListener('mousemove', function (e) {
      if (!drag) return
      var dx = e.clientX - drag.x
      var dy = e.clientY - drag.y
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
      var originX = lon2x(drag.lon, state.z) - dx
      var originY = lat2y(drag.lat, state.z) - dy
      state.center.lon = x2lon(originX, state.z)
      state.center.lat = y2lat(originY, state.z)
      draw()
    })
    window.addEventListener('mouseup', function (e) {
      if (!drag) return
      var moved = drag.moved
      drag = null
      if (moved) return
      var rect = canvas.getBoundingClientRect()
      var point = toLatLon(e.clientX - rect.left, e.clientY - rect.top)
      state.candidate = point
      state.center = { lat: point.lat, lon: point.lon }
      draw()
    })
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault()
      state.z = Math.max(3, Math.min(17, state.z + (e.deltaY > 0 ? -1 : 1)))
      draw()
    }, { passive: false })

    root.querySelectorAll('.ap-map-style button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.style = btn.getAttribute('data-style')
        state.tileFail = 0
        state.tileOk = 0
        root.querySelectorAll('.ap-map-style button').forEach(function (b) { b.classList.toggle('on', b === btn) })
        draw()
      })
    })

    function search(q) {
      if (!q || !q.trim()) { resultsBox.innerHTML = ''; return }
      fetch('/astro-plan/api/geocode?q=' + encodeURIComponent(q))
        .then(function (r) { return r.json() })
        .then(function (d) {
          var list = (d && d.results) || []
          if (!list.length) { resultsBox.innerHTML = '<div class="ap-map-empty">没找到，试试站点名/城市/县名，或直接在地图上点</div>'; return }
          resultsBox.innerHTML = ''
          list.forEach(function (item) {
            var row = document.createElement('button')
            row.type = 'button'
            row.className = 'ap-map-result'
            row.textContent = item.name + ' · ' + (item.sub || '') + '（' + Number(item.lat).toFixed(3) + ', ' + Number(item.lon).toFixed(3) + '）'
            row.addEventListener('click', function () {
              focus(item.lat, item.lon, 10)
              resultsBox.innerHTML = ''
            })
            resultsBox.appendChild(row)
          })
        }).catch(function () {
          resultsBox.innerHTML = '<div class="ap-map-empty">网络不可用，仅能在地图上手动选点</div>'
        })
    }

    var input = root.querySelector('.ap-map-q')
    var timer = null
    input.addEventListener('input', function () {
      clearTimeout(timer)
      var value = input.value
      timer = setTimeout(function () { search(value) }, 300)
    })
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { clearTimeout(timer); search(input.value) }
    })
    root.querySelector('.ap-map-find').addEventListener('click', function () { search(input.value) })

    root.querySelector('.ap-map-bortle').addEventListener('input', function (e) {
      state.bortle = Math.max(1, Math.min(9, Number(e.target.value) || 4))
    })
    root.querySelector('.ap-map-name').addEventListener('input', function (e) { state.name = e.target.value })

    root.querySelector('.ap-map-setorigin').addEventListener('click', function () {
      state.origin = { lat: state.candidate.lat, lon: state.candidate.lon, label: '地图所选' }
      if (o.onOrigin) o.onOrigin(state.origin)
      draw()
    })
    root.querySelector('.ap-map-ok').addEventListener('click', function () {
      if (o.onConfirm) o.onConfirm({
        lat: Math.round(state.candidate.lat * 1000) / 1000,
        lon: Math.round(state.candidate.lon * 1000) / 1000,
        bortle: state.bortle,
        name: state.name.trim(),
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
    window.addEventListener('resize', draw)

    return {
      focus: focus,
      setOrigin: function (origin) { state.origin = origin; draw() },
      setStyle: function (style) { state.style = style; draw() },
      getCandidate: function () { return { lat: state.candidate.lat, lon: state.candidate.lon, bortle: state.bortle } },
      destroy: function () { host.innerHTML = '' },
    }
  }

  return { mount: mount }
})()
`
