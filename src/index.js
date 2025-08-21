import * as Highcharts from 'highcharts';
import { parseMetadata } from './data/metadataParser';
import { processSeriesData } from './data/dataProcessor';
import { applyHighchartsDefaults } from './config/highchartsSetup';
import { createChartStylesheet } from './config/styles';

// ------------------------------------
// DataLabel text animation shim
// ------------------------------------
if (!Highcharts._barRaceLabelShimInstalled) {
    (function (H) {
        const FLOAT = /^-?\d+\.?\d*$/;

        H.Fx.prototype.textSetter = function () {
            const chart = H.charts[this.elem?.renderer?.chartIndex];
            if (!chart) return;

            let thousandsSep = chart.numberFormatter('1000.0')[1];
            if (/[0-9]/.test(thousandsSep)) thousandsSep = ' ';
            const replaceRegEx = new RegExp(thousandsSep, 'g');

            const sv = (this.start ?? '').toString().replace(replaceRegEx, '');
            const ev = (this.end ?? '').toString().replace(replaceRegEx, '');
            let current = ev;

            if (FLOAT.test(sv) && FLOAT.test(ev)) {
                const s = parseFloat(sv);
                const e = parseFloat(ev);
                current = chart.numberFormatter(Math.round(s + (e - s) * this.pos), 0);
            }
            this.elem.endText = this.end;
            this.elem.attr(this.prop, current, null, true);
        };

        H.SVGElement.prototype.textGetter = function () {
            const ct = this.text?.element?.textContent || '';
            return this.endText ? this.endText : ct.substring(0, Math.floor(ct.length / 2));
        };

        H.wrap(H.Series.prototype, 'drawDataLabels', function (proceed) {
            const attr = H.SVGElement.prototype.attr;
            const chart = this.chart;

            if (chart.sequenceTimer) {
                this.points.forEach(point =>
                    (point.dataLabels || []).forEach(label => {
                        label.attr = function (hash) {
                            if (hash && hash.text !== undefined && chart.isResizing === 0) {
                                const text = hash.text;
                                delete hash.text;
                                // animate only the text, keep other attrs synchronous
                                return this.attr(hash).animate({ text });
                            }
                            return attr.apply(this, arguments);
                        };
                    })
                );
            }

            const ret = proceed.apply(this, Array.prototype.slice.call(arguments, 1));
            this.points.forEach(p => (p.dataLabels || []).forEach(d => (d.attr = attr)));
            return ret;
        });
    })(Highcharts);

    Highcharts._barRaceLabelShimInstalled = true;
}

// ------------------------------------
// Safety patches for HC 12 teardown / pointer
// ------------------------------------
(function (H) {
    const wrap = H.wrap;

    // idempotent destroys (Chart/Series/Axis/Point/SVGElement)
    ['Chart', 'Series', 'Axis', 'Point'].forEach(ctor => {
        if (H[ctor]?.prototype) {
            wrap(H[ctor].prototype, 'destroy', function (proceed) {
                if (this.___destroyed) return;
                this.___destroyed = true;
                try { proceed.apply(this, Array.prototype.slice.call(arguments, 1)); } catch { }
            });
        }
    });

    // null-safe erase
    const origErase = H.erase;
    H.erase = function (arr, item) {
        if (!arr || typeof arr.length !== 'number') return;
        const i = (H.inArray ? H.inArray(item, arr) : arr.indexOf(item));
        if (i > -1) arr.splice(i, 1);
    };

    // survive races in destroyElements
    if (H.Chart?.prototype?.destroyElements) {
        wrap(H.Chart.prototype, 'destroyElements', function (proceed) {
            try { proceed.apply(this, Array.prototype.slice.call(arguments, 1)); } catch { }
        });
    }

    // make SVGElement.destroy idempotent + safe
    if (H.SVGElement?.prototype) {
        wrap(H.SVGElement.prototype, 'destroy', function (proceed) {
            if (this.___destroyed) return;
            this.___destroyed = true;
            try { proceed.apply(this, Array.prototype.slice.call(arguments, 1)); } catch { }
        });

        // guard translate (the 'x' error originates here in some races)
        const tName = 'translate';
        if (H.SVGElement.prototype[tName]) {
            wrap(H.SVGElement.prototype, tName, function (proceed) {
                try { return proceed.apply(this, Array.prototype.slice.call(arguments, 1)); }
                catch { return this; }
            });
        }
    }

    // tooltip/pointer safety – ensure we never depend on undefined event
    if (H.Pointer?.prototype) {
        wrap(H.Pointer.prototype, 'reset', function (proceed, e) {
            try { return proceed.call(this, e || { touched: false }); } catch { }
        });
    }
})(Highcharts);

// ------------------------------------
// Web component
// ------------------------------------
(function () {
    class BarRace extends HTMLElement {
        static get observedAttributes() { return []; }

        constructor() {
            super();
            this.attachShadow({ mode: 'open' });
            this.shadowRoot.adoptedStyleSheets = [createChartStylesheet()];
            this.shadowRoot.innerHTML = `
            <div id="parent-container">
                <div id="play-controls">
                    <button id="play-pause-button" title="play"
                        style="margin-left:10px;width:45px;height:45px;cursor:pointer;border:1px solid #004b8d;
                        border-radius:25px;color:white;background-color:#004b8d;transition:background-color 250ms;font-size:18px;">▶</button>
                    <input id="play-range" type="range" style="transform: translateY(2.5px); width: calc(100% - 90px); background:#f8f8f8;"/>
                </div>
                <div id="container"></div>
            </div>
            `;

            // internal state
            this._chart = null;
            this._currentIdx = 0;
            this._timelineSig = '';
            this._renderTimer = null;
            this._raf = 0;
            this._pendingIdx = null;

            // handlers
            this._onPlayPause = null;
            this._onSliderClick = null;


            // flags
            this._isDestroying = false;
            this._dragging = false;
        }

        // SAC hooks
        onCustomWidgetResize() { this._scheduleRender(); }
        onCustomWidgetAfterUpdate() { this._scheduleRender(); }
        attributeChangedCallback() { this._scheduleRender(); }

        onCustomWidgetDestroy() {
            if (this._isDestroying) return;
            this._isDestroying = true;

            // stop timers
            if (this._raf) cancelAnimationFrame(this._raf);
            this._raf = 0;
            this._pendingIdx = null;

            if (this._chart?.sequenceTimer) {
                clearInterval(this._chart.sequenceTimer);
                this._chart.sequenceTimer = undefined;
            }

            // detach listeners
            const btn = this.shadowRoot.getElementById('play-pause-button');
            const input = this.shadowRoot.getElementById('play-range');
            if (btn && this._onPlayPause) btn.removeEventListener('click', this._onPlayPause);
            if (input && this._onSliderClick) input.removeEventListener('click', this._onSliderClick);

            // best-effort neutralize hover before destroying
            try {
                if (this._chart) {
                    this._chart.hoverPoints = [];
                    this._chart.hoverPoint = null;
                    this._chart.pointer?.reset?.({ touched: false });
                }
            } catch { }

            try { this._chart?.destroy(); } catch { }
            this._chart = null;
            this._isDestroying = false;
        }

        _scheduleRender() {
            if (this._dragging) return;
            clearTimeout(this._renderTimer);
            this._renderTimer = setTimeout(() => this._renderChart(), 0);
        }

        _renderChart() {
            const dataBinding = this.dataBinding;
            if (!dataBinding || dataBinding.state !== 'success' || !dataBinding.data?.length) {
                this._teardownChart();
                return;
            }

            const { data, metadata } = dataBinding;
            const { dimensions, measures } = parseMetadata(metadata);
            if (dimensions.length < 2 || measures.length < 1) {
                this._teardownChart();
                return;
            }

            const structuredData = processSeriesData(data, dimensions, measures);

            // --- build timeline (supports "YYYY" and "MMM YYYY" and "YYYY-MM") ---
            const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
            const parseTimeKey = (key) => {
                if (key == null) return null;
                const s = String(key).trim();
                if (/^\d{4}$/.test(s)) return { y: +s, m: 1, label: s };
                let m = s.match(/^([A-Za-z]{3})\s+(\d{4})$/);
                if (m) {
                    const mon = MONTHS[m[1].toUpperCase()];
                    const yr = parseInt(m[2], 10);
                    if (mon && Number.isFinite(yr)) return { y: yr, m: mon, label: s };
                }
                m = s.match(/^(\d{4})[-\/](\d{1,2})$/);
                if (m) {
                    const yr = +m[1], mon = Math.max(1, Math.min(12, +m[2]));
                    return { y: yr, m: mon, label: s };
                }
                return null;
            };

            const labels = Object.keys(structuredData);
            if (!labels.length) { this._teardownChart(); return; }

            const timeline = labels
                .map(lbl => ({ lbl, ts: parseTimeKey(lbl) }))
                .filter(x => x.ts)
                .sort((a, b) => (a.ts.y - b.ts.y) || (a.ts.m - b.ts.m))
                .map(x => x.lbl);

            if (!timeline.length) { this._teardownChart(); return; }

            // reset to first label if the timeline changed (fixes "initially at last date")
            const newSig = timeline.join('|');
            const timelineChanged = newSig !== this._timelineSig;
            this._timelineSig = newSig;

            const btn = this.shadowRoot.getElementById('play-pause-button');
            const input = this.shadowRoot.getElementById('play-range');

            // index-based slider
            const minIdx = 0, maxIdx = timeline.length - 1;
            if (input.min !== String(minIdx)) input.min = String(minIdx);
            if (input.max !== String(maxIdx)) input.max = String(maxIdx);
            input.step = '1';

            if (timelineChanged) {
                this._currentIdx = 0;
                input.value = '0';
            } else {
                const prev = Number(input.value);
                this._currentIdx = Number.isFinite(prev) ? Math.max(minIdx, Math.min(maxIdx, prev)) : 0;
                input.value = String(this._currentIdx);
            }

            const nbr = 10;

            const getData = (label) => {
                const timeData = structuredData?.[label] || {};
                return Object.entries(timeData)
                    .map(([category, value]) => [category, Number(value) || 0])
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, nbr);
            };

            const getSubtitle = (label) => {
                const sum = Object.values(structuredData[label] || {}).reduce((s, v) => s + (Number(v) || 0), 0);
                const total = Highcharts.numberFormat(sum, 0, '.', ',');
                return `
                    <span style="font-size:80px">${label}</span>
                    <br>
                    <span style="font-size:22px">Total: <b>${total}</b></span>
                `;
            };

            const currentLabel = () => timeline[this._currentIdx];

            applyHighchartsDefaults();

            const baseChartOptions = {
                chart: { animation: { duration: 500 }, marginRight: 50 },
                title: { text: 'Chart Title', align: 'left' },
                subtitle: {
                    text: getSubtitle(currentLabel()),
                    floating: true, align: 'right', verticalAlign: 'middle',
                    useHTML: true, y: 100, x: -20
                },
                credits: { enabled: false },
                legend: { enabled: false },
                xAxis: { type: 'category' },
                yAxis: { opposite: true, tickPixelInterval: 150, title: { text: null } },
                plotOptions: {
                    series: {
                        animation: false,
                        groupPadding: 0, pointPadding: 0.1, borderWidth: 0, colorByPoint: true,
                        dataSorting: { enabled: true, matchByName: true },
                        type: 'bar',
                        dataLabels: { enabled: true },
                        // disable hover to avoid pointer races while updating
                        states: { hover: { enabled: false } }
                    }
                },
                tooltip: { enabled: true },
                series: [{
                    type: 'bar',
                    name: String(currentLabel()),
                    data: getData(currentLabel())
                }],
                responsive: {
                    rules: [{
                        condition: { maxWidth: 550 },
                        chartOptions: {
                            xAxis: { visible: false },
                            subtitle: { x: 0 },
                            plotOptions: {
                                series: {
                                    dataLabels: [
                                        { enabled: true, y: 8 },
                                        {
                                            enabled: true, format: '{point.name}', y: -8,
                                            style: { fontWeight: 'normal', opacity: 0.7 }
                                        }
                                    ]
                                }
                            }
                        }
                    }]
                }
            };

            if (!this._chart) {
                this._chart = Highcharts.chart(this.shadowRoot.getElementById('container'), baseChartOptions);
            } else {
                this._chart.update({ subtitle: { text: getSubtitle(currentLabel()) } }, false, false, false);
                this._chart.series[0].update({
                    name: String(currentLabel()),
                    data: getData(currentLabel())
                }, true, { duration: 500 });
            }

            const chart = this._chart;

            const setPlayingVisuals = (playing) => {
                // turn off tooltip while animating to avoid 'touched' races
                chart.update({
                    tooltip: { enabled: !playing },
                    plotOptions: { series: { states: { hover: { enabled: !playing } } } }
                }, false, false, false);
                chart.redraw(false);
            };

            const pause = (button) => {
                button.title = 'play';
                button.innerText = '▶';
                button.style.fontSize = '18px';
                if (chart.sequenceTimer) clearInterval(chart.sequenceTimer);
                chart.sequenceTimer = undefined;
                setPlayingVisuals(false);
            };

            const doUpdateNow = (idx) => {
                if (!Number.isFinite(idx)) idx = minIdx;
                idx = Math.max(minIdx, Math.min(maxIdx, idx));
                this._currentIdx = idx;
                input.value = String(idx);

                const label = currentLabel();

                if (idx >= maxIdx) pause(btn);

                chart.update({ subtitle: { text: getSubtitle(label) } }, false, false, false);
                chart.series[0].update({
                    name: String(label),
                    data: getData(label)
                }, true, { duration: 500 });
            };

            // rAF-batched updater (prevents stacked updates during play)
            const requestUpdate = (idx) => {
                this._pendingIdx = idx;
                if (this._raf) return;
                this._raf = requestAnimationFrame(() => {
                    this._raf = 0;
                    const next = this._pendingIdx;
                    this._pendingIdx = null;
                    doUpdateNow(next);
                });
            };

            const doUpdate = (increment) => {
                let idx = parseInt(input.value || '0', 10);
                if (!Number.isFinite(idx)) idx = minIdx;
                if (increment) idx += increment;
                requestUpdate(idx);
            };

            const play = (button) => {
                button.title = 'pause';
                button.innerText = '⏸';
                button.style.fontSize = '22px';
                if (chart.sequenceTimer) clearInterval(chart.sequenceTimer);
                setPlayingVisuals(true);
                chart.sequenceTimer = setInterval(() => doUpdate(1), 1000);
            };

            // wire events
            if (this._onPlayPause) btn.removeEventListener('click', this._onPlayPause);
            this._onPlayPause = () => (chart.sequenceTimer ? pause(btn) : play(btn));
            btn.addEventListener('click', this._onPlayPause);

            if (this._onSliderClick) input.removeEventListener('click', this._onSliderClick);
            this._onSliderClick = () => { setPlayingVisuals(false); doUpdate(0); };
            input.addEventListener('click', this._onSliderClick);

            input.style.touchAction = 'none'; // disable touch events
            
        }

        _teardownChart() {
            if (this._isDestroying) return;
            this._isDestroying = true;

            const btn = this.shadowRoot.getElementById('play-pause-button');
            const input = this.shadowRoot.getElementById('play-range');

            if (this._chart?.sequenceTimer) {
                clearInterval(this._chart.sequenceTimer);
                this._chart.sequenceTimer = undefined;
            }

            if (btn && this._onPlayPause) btn.removeEventListener('click', this._onPlayPause);
            if (input && this._onSliderClick) input.removeEventListener('click', this._onSliderClick);

            try {
                if (this._chart) {
                    this._chart.hoverPoints = [];
                    this._chart.hoverPoint = null;
                    this._chart.pointer?.reset?.({ touched: false });
                    this._chart.series?.forEach(s => s.update({ data: [] }, false));
                    this._chart.redraw(false);
                    this._chart.destroy();
                }
            } catch { }
            this._chart = null;
            this._isDestroying = false;
        }
    }

    customElements.define('com-sap-sample-bar-race', BarRace);
})();