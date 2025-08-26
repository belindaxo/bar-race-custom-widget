import * as Highcharts from 'highcharts';
import { parseMetadata } from './data/metadataParser';
import { processSeriesData } from './data/dataProcessor';
import { applyHighchartsDefaults } from './config/highchartsSetup';
import { createChartStylesheet } from './config/styles';

// // Install the data label text animation shim
// if (!Highcharts._barRaceLabelShimInstalled) {
//     (function (H) {
//         const FLOAT = /^-?\d+\.?\d*$/;

//         H.Fx.prototype.textSetter = function () {
//             const chart = H.charts[this.elem.renderer.chartIndex];

//             let thousandsSep = chart.numberFormatter('1000.0')[1];
//             if (/[0-9]/.test(thousandsSep)) {
//                 thousandsSep = ' ';
//             }
//             const replaceRegEx = new RegExp(thousandsSep, 'g');

//             let startValue = (this.start ?? '').toString().replace(replaceRegEx, '');
//             let endValue = (this.end ?? '').toString().replace(replaceRegEx, '');
//             let currentValue = endValue;

//             if (FLOAT.test(startValue) && FLOAT.test(endValue)) {
//                 const s = parseFloat(startValue);
//                 const e = parseFloat(endValue);
//                 currentValue = chart.numberFormatter(Math.round(s + (e - s) * this.pos), 0);
//             }
//             this.elem.endText = this.end;
//             this.elem.attr(this.prop, currentValue, null, true);
//         };

//         H.SVGElement.prototype.textGetter = function () {
//             const ct = this.text.element.textContent || '';
//             return this.endText ? this.endText : ct.substring(0, Math.floor(ct.length / 2));
//         };

//         H.wrap(H.Series.prototype, 'drawDataLabels', function (proceed) {
//             const attr = H.SVGElement.prototype.attr;
//             const chart = this.chart;

//             if (chart.sequenceTimer) {
//                 this.points.forEach(point =>
//                     (point.dataLabels || []).forEach(label => {
//                         label.attr = function (hash) {
//                             if (hash && hash.text !== undefined && chart.isResizing === 0) {
//                                 const text = hash.text;
//                                 delete hash.text;
//                                 return this.attr(hash).animate({ text });
//                             }
//                             return attr.apply(this, arguments);
//                         };
//                     })
//                 );
//             }

//             const ret = proceed.apply(this, Array.prototype.slice.call(arguments, 1));
//             this.points.forEach(p => (p.dataLabels || []).forEach(d => (d.attr = attr)));
//             return ret;
//         });
//     })(Highcharts);

//     Highcharts._barRaceLabelShimInstalled = true;
// }

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
            this._currentYear = undefined;
            this._renderTimer = null;

            // RAF batching
            this._raf = 0;
            this._pendingYear = null;

            // handlers
            this._onPlayPause = null;
            this._onSliderInput = null;

            // flags
            this._isDestroying = false;
            this._dragging = false;
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
            this._pendingYear = null;
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
            if (input && this._onSliderInput) input.removeEventListener('input', this._onSliderInput);

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

            const labelKeys = Object.keys(structuredData);
            let years;
            const numericYears = labelKeys.map(k => Number(k));
            if (numericYears.every(Number.isFinite)) {
                years = numericYears.sort((a, b) => a - b);
            } else {
                years = labelKeys;
            }
            if (!years.length) {
                this._teardownChart();
                return;
            }

            const startYear = years[0];
            console.log('startYear: ', startYear);
            const endYear = years[years.length - 1];
            console.log('endYear: ', endYear);
            const nbr = 10;

            const btn = this.shadowRoot.getElementById('play-pause-button');
            const input = this.shadowRoot.getElementById('play-range');
            const containerEl = this.shadowRoot.getElementById('container');
            if (!containerEl) return; // container detached

            // slider bounds
            const minStr = String(startYear);
            const maxStr = String(endYear);
            if (input.min !== minStr) input.min = minStr;
            if (input.max !== maxStr) input.max = maxStr;
            input.step = '1';

            // current year with clamping
            const prev = Number(input.value);
            if (Number.isFinite(prev)) {
                this._currentYear = Math.max(Number(startYear), Math.min(Number(endYear), prev));
                input.value = String(this._currentYear);
            } else {
                this._currentYear = Number(startYear);
                input.value = String(startYear);
            }

            const getData = (year) => {
                const yKey = String(year);
                const timeData = structuredData?.[yKey] || {};
                return Object.entries(timeData)
                    .map(([category, value]) => [category, Number(value) || 0])
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, nbr);
            };

            const getSubtitle = (year) => {
                const yKey = String(year);
                const sum = Object.values(structuredData[yKey] || {}).reduce((s, v) => s + (Number(v) || 0), 0);
                const total = Highcharts.numberFormat(sum, 0, '.', ',');
                return `
          <span style="font-size: 80px">${year}</span>
          <br>
          <span style="font-size: 22px">
          Total: <b>${total}</b>
          </span>
        `;
            };

            applyHighchartsDefaults();

            if (!this._chart) {
                const chartOptions = {
                    chart: { animation: { duration: 500 }, marginRight: 50 },
                    title: { text: 'Chart Title', align: 'left' },
                    subtitle: {
                        text: getSubtitle(this._currentYear),
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
                    series: [{ type: 'bar', name: String(this._currentYear), data: getData(this._currentYear) }],
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
                this._chart.update({ subtitle: { text: getSubtitle(this._currentYear) } }, false, false, false);
                this._chart.series[0].update({ name: String(this._currentYear), data: getData(this._currentYear) }, true, { duration: 500 });
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

                let yr = parseInt(input.value, 10);
                if (!Number.isFinite(yr)) yr = Number(startYear);
                yr = Math.max(Number(startYear), Math.min(Number(endYear), yr));
                input.value = String(yr);

                this._pendingYear = yr;
                if (this._raf) return;

                this._raf = requestAnimationFrame(() => {
                    this._raf = 0;
                    const year = this._pendingYear;
                    this._pendingYear = null;

                    if (this._isDestroying || !this._chart) return;
                    const chartNow = this._chart;

                    if (year >= Number(endYear)) {
                        pause(btn);
                    }

                    chartNow.update({ subtitle: { text: getSubtitle(year) } }, false, false, false);
                    chartNow.series[0].update({ name: String(year), data: getData(year) }, true, { duration: 500 });

                    this._currentYear = year;
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

            if (this._onSliderInput) input.removeEventListener('input', this._onSliderInput);
            this._onSliderInput = () => doUpdate(0);
            input.addEventListener('input', this._onSliderInput);

            input.style.touchAction = 'none';
        }

        _teardownChart() {
            if (this._isDestroying) return;
            this._isDestroying = true;

            // cancel rAF and reset state
            if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
            this._pendingYear = null;
            this._dragging = false;

            const btn = this.shadowRoot.getElementById('play-pause-button');
            const input = this.shadowRoot.getElementById('play-range');

            if (this._chart && this._chart.sequenceTimer) {
                clearInterval(this._chart.sequenceTimer);
                this._chart.sequenceTimer = undefined;
            }
            try { Highcharts.stop && Highcharts.stop(this._chart); } catch { }

            if (btn && this._onPlayPause) btn.removeEventListener('click', this._onPlayPause);
            if (input && this._onSliderInput) input.removeEventListener('input', this._onSliderInput);

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