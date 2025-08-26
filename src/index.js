import * as Highcharts from 'highcharts';
import { parseMetadata } from './data/metadataParser';
import { processSeriesData } from './data/dataProcessor';
import { applyHighchartsDefaults } from './config/highchartsSetup';
import { createChartStylesheet } from './config/styles';

/* ---------- SAFETY PATCHES: HC teardown hardening (idempotent destroy + null-safe erase) ---------- */
(function (H) {
    const wrap = H.wrap;

    // Idempotent destroy for main types
    if (H.Chart) wrap(H.Chart.prototype, 'destroy', function (proceed) { if (this.___destroyed) return; this.___destroyed = true; try { proceed.apply(this, [].slice.call(arguments, 1)); } catch { } });
    if (H.Series) wrap(H.Series.prototype, 'destroy', function (proceed) { if (this.___destroyed) return; this.___destroyed = true; try { proceed.apply(this, [].slice.call(arguments, 1)); } catch { } });
    if (H.Axis) wrap(H.Axis.prototype, 'destroy', function (proceed) { if (this.___destroyed) return; this.___destroyed = true; try { proceed.apply(this, [].slice.call(arguments, 1)); } catch { } });
    if (H.Point) wrap(H.Point.prototype, 'destroy', function (proceed) { if (this.___destroyed) return; this.___destroyed = true; try { proceed.apply(this, [].slice.call(arguments, 1)); } catch { } });

    // Null-safe erase
    const origErase = H.erase;
    H.erase = function (arr, item) {
        if (!arr || typeof arr.length !== 'number') return;
        const i = (H.inArray ? H.inArray(item, arr) : arr.indexOf(item));
        if (i > -1) arr.splice(i, 1);
    };

    // Guard destroyElements to survive races
    if (H.Chart && H.Chart.prototype && H.Chart.prototype.destroyElements) {
        wrap(H.Chart.prototype, 'destroyElements', function (proceed) {
            try { proceed.apply(this, [].slice.call(arguments, 1)); } catch { }
        });
    }
})(Highcharts);
/* -------------------------------------------------------------------------------------------------- */

/* ----- EXTRA SAFETY PATCHES for HC 12.x: SVG teardown idempotent ----- */
(function (H) {
    if (!H || !H.SVGElement) return;
    const wrap = H.wrap;

    // Make every SVGElement destroy idempotent
    wrap(H.SVGElement.prototype, 'destroy', function (proceed) {
        if (this.___destroyed) return;
        this.___destroyed = true;

        // Best-effort: ensure some renderer collections are arrays so internal erase() won't see null
        try {
            const r = this.renderer;
            if (r) {
                if (Array.isArray(r.alignedObjects) === false) r.alignedObjects = [];
                if (Array.isArray(r.gradients) === false) r.gradients = [];
            }
            const chart = r && Highcharts.charts ? Highcharts.charts[r.chartIndex] : null;
            if (chart) {
                chart.hoverPoints = chart.hoverPoints || [];
                chart.hoverPoint = chart.hoverPoint || null;
            }
        } catch { }

        try { proceed.apply(this, Array.prototype.slice.call(arguments, 1)); }
        catch (e) { /* swallow second-pass SVG cleanup in SAC */ }
    });

    // Tooltip/pointer safety
    if (H.Tooltip && H.Tooltip.prototype) {
        wrap(H.Tooltip.prototype, 'destroy', function (proceed) {
            if (this.___destroyed) return;
            this.___destroyed = true;
            try { proceed.apply(this, Array.prototype.slice.call(arguments, 1)); } catch { }
        });
    }
    if (H.Pointer && H.Pointer.prototype) {
        wrap(H.Pointer.prototype, 'reset', function (proceed) {
            try { proceed.apply(this, Array.prototype.slice.call(arguments, 1)); } catch { }
        });
    }
})(Highcharts);
/* --------------------------------------------------------------------- */

(function () {
    class BarRace extends HTMLElement {
        constructor() {
            super();
            this.attachShadow({ mode: 'open' });

            this.shadowRoot.adoptedStyleSheets = [createChartStylesheet()];
            this.shadowRoot.innerHTML = `
                <div id="parent-container">
                <div id="play-controls">
                    <button id="play-pause-button" title="play" style="margin-left: 10px; width: 45px; height: 45px; cursor: pointer; border: 1px solid #004b8d;
                    border-radius: 25px; color: white; background-color: #004b8d; transition: background-color 250ms; font-size: 18px;">▶</button>
                    <input id="play-range" type="range" style="transform: translateY(2.5px); width: calc(100% - 90px); background: #f8f8f8;"/>
                </div>
                <div id="container"></div>
                </div>
            `;

            // internal state
            this._chart = null;
            this._currentIdx = 0;
            this._renderTimer = null;

            // RAF batching
            this._raf = 0;
            this._pendingIdx = null;

            // handlers
            this._onPlayPause = null;
            this._onSliderInput = null;

            // flags
            this._isDestroying = false;
            this._dragging = false;

            // timeline signature
            this._timelineSig = '';
        }

        onCustomWidgetResize() {
            this._scheduleRender();
        }
        onCustomWidgetAfterUpdate() {
            this._scheduleRender();
        }

        onCustomWidgetDestroy() {
            if (this._isDestroying) return;
            this._isDestroying = true;

            // cancel any scheduled rAF update
            if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
            this._pendingIdx = null;
            this._dragging = false;

            // pause autoplay first
            if (this._chart && this._chart.sequenceTimer) {
                clearInterval(this._chart.sequenceTimer);
                this._chart.sequenceTimer = undefined;
            }

            try { Highcharts.stop && Highcharts.stop(this._chart); } catch { }

            // detach listeners
            const btn = this.shadowRoot.getElementById('play-pause-button');
            const input = this.shadowRoot.getElementById('play-range');
            if (btn && this._onPlayPause) btn.removeEventListener('click', this._onPlayPause);
            if (input && this._onSliderInput) input.removeEventListener('change', this._onSliderInput);

            // neutralize hover state before destroy
            try {
                if (this._chart) {
                    this._chart.hoverPoints = [];
                    this._chart.hoverPoint = null;
                    this._chart.pointer?.reset?.(true);
                }
            } catch { }

            try { this._chart && this._chart.destroy(); } catch { }
            this._chart = null;
            this._isDestroying = false;
        }

        _scheduleRender() {
            if (this._dragging) return;
            clearTimeout(this._renderTimer);
            this._renderTimer = setTimeout(() => this._renderChart(), 0);
        }

        attributeChangedCallback(name, oldValue, newValue) {
            if (oldValue !== newValue) {
                this[name] = newValue;
                this._scheduleRender();
            }
        }

        _renderChart() {
            // guard: SAC might call while detaching
            if (this._isDestroying || !this.isConnected) return;

            const dataBinding = this.dataBinding;
            if (!dataBinding || dataBinding.state !== 'success' || !dataBinding.data || dataBinding.data.length === 0) {
                this._teardownChart();
                return;
            }
            console.log('dataBinding:', dataBinding);
            const { data, metadata } = dataBinding;
            const { dimensions, measures } = parseMetadata(metadata);
            if (dimensions.length < 2 || measures.length < 1) {
                this._teardownChart();
                return;
            }

            const structuredData = processSeriesData(data, dimensions, measures);
            console.log('structuredData:', structuredData);

            const MONTHS = { 
                JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, 
                JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 
            };

            const parseTimeKey = (key) => {
                if (key == null) return null;
                const s = String(key).trim();

                // YYYY
                if (/^\d{4}$/.test(s)) return { y: +s, m: 1, label: s };

                // MMM YYYY
                let m = s.match(/^([A-Za-z]{3})\s+(\d{4})$/);
                if (m) {
                    const mon = MONTHS[m[1].toUpperCase()];
                    const yr = +m[2];
                    if (mon && Number.isFinite(yr)) return { y: yr, m: mon, label: s };
                }

                // MM/YYYY
                m = s.match(/^(\d{2})\/(\d{4})$/);
                if (m) {
                    const mon = Math.max(1, Math.min(12, +m[1]));
                    const yr = +m[2];
                    return { y: yr, m: mon, label: s };
                }

                return null;
            }

            const labels = Object.keys(structuredData);
            if (!labels.length) { this._teardownChart(); return; }

            const timeline = labels
                .map(lbl => ({ lbl, ts: parseTimeKey(lbl) }))
                .filter(x => x.ts) // keep only parseable keys
                .sort((a,b) => (a.ts.y - b.ts.y) || (a.ts.m - b.ts.m))
                .map(x => x.lbl);
            
            if (!timeline.length) { this._teardownChart(); return; }

            const btn = this.shadowRoot.getElementById('play-pause-button');
            const input = this.shadowRoot.getElementById('play-range');
            const containerEl = this.shadowRoot.getElementById('container');
            if (!containerEl) return; // container detached

            // slider bounds
            const minIdx = 0;
            const maxIdx = timeline.length - 1;
            if (input.min !== String(minIdx)) input.min = String(minIdx);
            if (input.max !== String(maxIdx)) input.max = String(maxIdx);
            input.step = '1';

            const firstRender = !this._chart;
            const newSig = timeline.join('|');
            const timelineChanged = newSig !== this._timelineSig;
            this._timelineSig = newSig;

            if (firstRender || timelineChanged) {
                this._currentIdx = 0;
                input.value = '0';
            } else {
                const prev = Number(input.value);
                this._currentIdx = Number.isFinite(prev) ? Math.max(minIdx, Math.min(maxIdx, prev)) : 0;
                input.value = String(this._currentIdx);
            }

            // clamp current index
            const prevIdx = Number(input.value);
            if (Number.isFinite(prevIdx)) {
                this._currentIdx = Math.max(minIdx, Math.min(maxIdx, prevIdx));
                input.value = String(this._currentIdx);
            } else {
                this._currentIdx = 0;
                input.value = '0';
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
                    <span style="font-size: 80px">${label}</span>
                    <br>
                    <span style="font-size: 22px">
                        Total: <b>${total}</b>
                    </span>
                `;
            };

            const currentLabel = () => timeline[this._currentIdx];

            applyHighchartsDefaults();

            if (!this._chart) {
                const chartOptions = {
                    chart: { animation: { duration: 1000 }, marginRight: 50 },
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
                            animation: false, groupPadding: 0, pointPadding: 0.1, borderWidth: 0,
                            colorByPoint: true,
                            dataSorting: { enabled: true, matchByName: true },
                            type: 'bar',
                            dataLabels: { enabled: true }
                        }
                    },
                    series: [{ type: 'bar', name: String(currentLabel()), data: getData(currentLabel()) }],
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
                                            { enabled: true, format: '{point.name}', y: -8, style: { fontWeight: 'normal', opacity: 0.7 } }
                                        ]
                                    }
                                }
                            }
                        }]
                    }
                };
                this._chart = Highcharts.chart(containerEl, chartOptions);
            } else {
                this._chart.update({ subtitle: { text: getSubtitle(currentLabel()) } }, false, false, false);
                this._chart.series[0].update({ name: String(currentLabel()), data: getData(currentLabel()) }, true, { duration: 1000 });
            }

            const chart = this._chart;

            const pause = (button) => {
                button.title = 'play';
                button.innerText = '▶';
                button.style.fontSize = '18px';
                if (chart.sequenceTimer) clearInterval(chart.sequenceTimer);
                chart.sequenceTimer = undefined;
            };

            // RAF-batched updates
            const doUpdate = (increment) => {
                if (increment) {
                    input.value = String(parseInt(input.value, 10) + increment);
                }

                let idx = parseInt(input.value, 10);
                if (!Number.isFinite(idx)) idx = minIdx;
                idx = Math.max(minIdx, Math.min(maxIdx, idx));
                input.value = String(idx);

                this._pendingIdx = idx;
                if (this._raf) return;

                this._raf = requestAnimationFrame(() => {
                    this._raf = 0;
                    const nextIdx = this._pendingIdx;
                    this._pendingIdx = null;

                    if (this._isDestroying || !this._chart) return;
                    const chartNow = this._chart;
                    const label = timeline[nextIdx];

                    if (nextIdx >= maxIdx) {
                        pause(btn);
                    }

                    // neutralize pointer/tooltip state before update
                    try {
                        chartNow.hoverPoints = [];
                        chartNow.hoverPoint = null;
                        chartNow.pointer?.reset?.({ touched: false });
                        chartNow.tooltip?.hide?.(0);
                    } catch { }

                    // compute next frame
                    const nextData = getData(label);
                    const s0 = chartNow.series && chartNow.series[0];

                    // batch: subtitle -> data -> name -> single redraw
                    chartNow.update({ subtitle: { text: getSubtitle(label) } }, false, false, false);

                    if (s0) {
                        // make sure dataSorting is still on, but replace data atomically
                        s0.update({ dataSorting: { enabled: true, matchByName: true } }, false, false);
                        // setData 
                        s0.setData(nextData, false, false, false);
                        s0.update({ name: String(label) }, false, false);
                    }

                    chartNow.redraw();

                    this._currentIdx = nextIdx;
                });
            };

            const play = (button) => {
                button.title = 'pause';
                button.innerText = '⏸';
                button.style.fontSize = '22px';
                if (chart.sequenceTimer) clearInterval(chart.sequenceTimer);
                chart.sequenceTimer = setInterval(() => doUpdate(1), 500);
            };

            // (re)bind listeners
            if (this._onPlayPause) btn.removeEventListener('click', this._onPlayPause);
            this._onPlayPause = () => { if (chart.sequenceTimer) pause(btn); else play(btn); };
            btn.addEventListener('click', this._onPlayPause);

            if (this._onSliderInput) input.removeEventListener('change', this._onSliderInput);
            this._onSliderInput = () => doUpdate(0);
            input.addEventListener('change', this._onSliderInput);

            input.style.touchAction = 'none';
        }

        _teardownChart() {
            if (this._isDestroying) return;
            this._isDestroying = true;

            // cancel rAF and reset state
            if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
            this._pendingIdx = null;
            this._dragging = false;

            const btn = this.shadowRoot.getElementById('play-pause-button');
            const input = this.shadowRoot.getElementById('play-range');

            if (this._chart && this._chart.sequenceTimer) {
                clearInterval(this._chart.sequenceTimer);
                this._chart.sequenceTimer = undefined;
            }
            try { Highcharts.stop && Highcharts.stop(this._chart); } catch { }

            if (btn && this._onPlayPause) btn.removeEventListener('click', this._onPlayPause);
            if (input && this._onSliderInput) input.removeEventListener('change', this._onSliderInput);

            // neutralize hover state then destroy
            try {
                if (this._chart) {
                    this._chart.hoverPoints = [];
                    this._chart.hoverPoint = null;
                    this._chart.pointer?.reset?.(true);
                }
            } catch { }

            try { if (this._chart) this._chart.destroy(); } catch { }
            this._chart = null;
            this._isDestroying = false;
        }
    }

    customElements.define('com-sap-sample-bar-race', BarRace);
})();