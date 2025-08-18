import * as Highcharts from 'highcharts';
import { parseMetadata } from './data/metadataParser';
import { processSeriesData } from './data/dataProcessor';
import { applyHighchartsDefaults } from './config/highchartsSetup';
import { createChartStylesheet } from './config/styles';

/* =========================
   Highcharts label tween shim
   ========================= */
if (!Highcharts._barRaceLabelShimInstalled) {
    (function (H) {
        const FLOAT = /^-?\d+\.?\d*$/;

        H.Fx.prototype.textSetter = function () {
            const chart = H.charts[this.elem?.renderer?.chartIndex];
            if (!chart) return;

            let thousandsSep = chart.numberFormatter('1000.0')[1];
            if (/[0-9]/.test(thousandsSep)) {
                thousandsSep = ' ';
            }
            const replaceRegEx = new RegExp(thousandsSep, 'g');

            let startValue = (this.start ?? '').toString().replace(replaceRegEx, '');
            let endValue = (this.end ?? '').toString().replace(replaceRegEx, '');
            let currentValue = endValue;

            if (FLOAT.test(startValue) && FLOAT.test(endValue)) {
                const s = parseFloat(startValue);
                const e = parseFloat(endValue);
                currentValue = chart.numberFormatter(Math.round(s + (e - s) * this.pos), 0);
            }
            if (this.elem) {
                this.elem.endText = this.end;
                this.elem.attr && this.elem.attr(this.prop, currentValue, null, true);
            }
        };

        H.SVGElement.prototype.textGetter = function () {
            const ct = this.text?.element?.textContent || '';
            return this.endText ? this.endText : ct.substring(0, Math.floor(ct.length / 2));
        };

        H.wrap(H.Series.prototype, 'drawDataLabels', function (proceed) {
            const attr = H.SVGElement.prototype.attr;
            const chart = this.chart;

            if (chart && chart.sequenceTimer) {
                this.points.forEach(point =>
                    (point.dataLabels || []).forEach(label => {
                        label.attr = function (hash) {
                            if (hash && hash.text !== undefined && chart.isResizing === 0) {
                                const text = hash.text;
                                delete hash.text;
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

/* =========================
   Helpers: timeline parsing
   ========================= */
const MONTHS = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12
};

function parseLabelToYM(label) {
    if (label == null) return null;
    const s = String(label).trim();

    // YYYY
    if (/^\d{4}$/.test(s)) {
        return { year: parseInt(s, 10), month: 0 };
    }

    // MMM YYYY (case-insensitive on MMM)
    const m1 = /^([A-Za-z]{3})\s+(\d{4})$/.exec(s);
    if (m1) {
        const mon = m1[1].toUpperCase();
        const month = MONTHS[mon];
        if (month) return { year: parseInt(m1[2], 10), month };
    }

    // YYYY-MM
    const m2 = /^(\d{4})-(\d{2})$/.exec(s);
    if (m2) {
        return { year: parseInt(m2[1], 10), month: parseInt(m2[2], 10) };
    }

    // MM/YYYY
    const m3 = /^(\d{2})\/(\d{4})$/.exec(s);
    if (m3) {
        return { year: parseInt(m3[2], 10), month: parseInt(m3[1], 10) };
    }

    return null; // unknown format
}

/** Returns a sorted timeline of labels plus a lookup map. */
function buildTimeline(structuredData) {
    const labels = Object.keys(structuredData || {});
    if (!labels.length) return { timeline: [], labelToIndex: new Map() };

    // map each label to sortable (year, month)
    const enriched = labels.map((lbl, i) => {
        const ym = parseLabelToYM(lbl);
        return {
            label: lbl,
            year: ym ? ym.year : Number.NaN,
            month: ym ? ym.month : 0,
            // keep original index for a stable fallback
            orig: i,
            parsed: !!ym
        };
    });

    // sort:
    // - parsed ones by year asc, month asc
    // - unparsed ones to the end, original order
    enriched.sort((a, b) => {
        if (a.parsed && b.parsed) {
            if (a.year !== b.year) return a.year - b.year;
            return a.month - b.month;
        }
        if (a.parsed && !b.parsed) return -1;
        if (!a.parsed && b.parsed) return 1;
        return a.orig - b.orig;
    });

    const timeline = enriched.map(e => e.label);
    const labelToIndex = new Map();
    timeline.forEach((lbl, idx) => labelToIndex.set(lbl, idx));
    return { timeline, labelToIndex };
}

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

            // state
            this._chart = null;
            this._renderTimer = null;
            this._isDestroying = false;
            this._dragging = false;

            // timeline state
            this._timeline = [];     // array of labels in chronological order
            this._currentIndex = 0;  // frame index (0..timeline.length-1)

            // bound handlers
            this._onPlayPause = null;
            this._onSliderInput = null;
            this._onSliderChange = null;
            this._onSliderDown = null;
            this._onSliderMove = null;
            this._onSliderUp = null;
            this._onSliderCancel = null;
        }

        onCustomWidgetResize() { this._scheduleRender(); }
        onCustomWidgetAfterUpdate() { this._scheduleRender(); }

        onCustomWidgetDestroy() {
            if (this._isDestroying) return;
            this._isDestroying = true;

            const btn = this.shadowRoot.getElementById('play-pause-button');
            const input = this.shadowRoot.getElementById('play-range');

            try {
                if (this._chart && this._chart.sequenceTimer) {
                    clearInterval(this._chart.sequenceTimer);
                    this._chart.sequenceTimer = undefined;
                }
            } catch { }

            try { Highcharts.stop && Highcharts.stop(this._chart); } catch { }

            // detach DOM listeners
            if (btn && this._onPlayPause) btn.removeEventListener('click', this._onPlayPause);
            if (input && this._onSliderInput) input.removeEventListener('input', this._onSliderInput);
            if (input && this._onSliderChange) input.removeEventListener('change', this._onSliderChange);
            if (input && this._onSliderDown) input.removeEventListener('pointerdown', this._onSliderDown);
            if (input && this._onSliderMove) input.removeEventListener('pointermove', this._onSliderMove);
            if (input && this._onSliderUp) input.removeEventListener('pointerup', this._onSliderUp);
            if (input && this._onSliderCancel) input.removeEventListener('pointercancel', this._onSliderCancel);

            try {
                if (this._chart) {
                    this._chart.series?.forEach(s => s.update({ data: [] }, false));
                    this._chart.redraw(false);
                    this._chart.destroy();
                }
            } catch { }
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
            const binding = this.dataBinding;
            if (!binding || binding.state !== 'success' || !binding.data || !binding.data.length) {
                this._teardownChart();
                return;
            }

            const { data, metadata } = binding;
            const { dimensions, measures } = parseMetadata(metadata);
            if (dimensions.length < 2 || measures.length < 1) {
                this._teardownChart();
                return;
            }

            const structuredData = processSeriesData(data, dimensions, measures);

            // Build timeline from structuredData keys (handles YYYY, MMM YYYY, YYYY-MM, MM/YYYY)
            const { timeline } = buildTimeline(structuredData);
            if (!timeline.length) {
                this._teardownChart();
                return;
            }
            this._timeline = timeline;

            const btn = this.shadowRoot.getElementById('play-pause-button');
            const input = this.shadowRoot.getElementById('play-range');

            // slider is 0..N-1
            const maxIndex = this._timeline.length - 1;
            const minStr = '0';
            const maxStr = String(maxIndex);
            if (input.min !== minStr) input.min = minStr;
            if (input.max !== maxStr) input.max = maxStr;
            input.step = '1';

            // keep or clamp current index
            const prev = Number(input.value);
            if (Number.isFinite(prev)) {
                this._currentIndex = Math.max(0, Math.min(maxIndex, prev));
            } else {
                this._currentIndex = 0;
            }
            input.value = String(this._currentIndex);

            const getLabel = i => this._timeline[i] ?? this._timeline[0];

            const getData = (i) => {
                const key = getLabel(i);
                const frame = structuredData?.[key] || {};
                return Object.entries(frame)
                    .filter(([k]) => k !== 'Totals') // exclude optional Totals bucket from bars
                    .map(([category, value]) => [category, Number(value) || 0])
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 10);
            };

            const getSubtitle = (i) => {
                const key = getLabel(i);
                const frame = structuredData?.[key] || {};
                let total = (typeof frame.Totals === 'number')
                    ? frame.Totals
                    : Object.values(frame).reduce((s, v) => s + (Number(v) || 0), 0);
                total = Number.isFinite(total) ? total : 0;
                const pretty = Highcharts.numberFormat(total, 0, '.', ',');
                return `
          <span style="font-size: 64px">${key}</span>
          <br>
          <span style="font-size: 20px">Total: <b>${pretty}</b></span>
        `;
            };

            applyHighchartsDefaults();

            // Create or refresh chart
            if (!this._chart) {
                const chartOptions = {
                    chart: {
                        animation: { duration: 500 },
                        marginRight: 50
                    },
                    title: { text: 'Chart Title', align: 'left' },
                    subtitle: {
                        text: getSubtitle(this._currentIndex),
                        floating: true,
                        align: 'right',
                        verticalAlign: 'middle',
                        useHTML: true,
                        y: 90,
                        x: -20
                    },
                    credits: { enabled: false },
                    legend: { enabled: false },
                    xAxis: { type: 'category' },
                    yAxis: {
                        opposite: true,
                        tickPixelInterval: 150,
                        title: { text: null }
                    },
                    plotOptions: {
                        series: {
                            animation: false,
                            groupPadding: 0,
                            pointPadding: 0.1,
                            borderWidth: 0,
                            colorByPoint: true,
                            dataSorting: { enabled: true, matchByName: true },
                            type: 'bar',
                            dataLabels: { enabled: true }
                        }
                    },
                    series: [{
                        type: 'bar',
                        name: String(getLabel(this._currentIndex)),
                        data: getData(this._currentIndex)
                    }],
                    responsive: {
                        rules: [{
                            condition: { maxWidth: 550 },
                            chartOptions: {
                                xAxis: { visible: false },
                                subtitle: { x: 0 },
                                plotOptions: {
                                    series: {
                                        dataLabels: [{
                                            enabled: true, y: 8
                                        }, {
                                            enabled: true,
                                            format: '{point.name}',
                                            y: -8,
                                            style: { fontWeight: 'normal', opacity: 0.7 }
                                        }]
                                    }
                                }
                            }
                        }]
                    }
                };
                this._chart = Highcharts.chart(this.shadowRoot.getElementById('container'), chartOptions);
            } else {
                try {
                    this._chart.update({ subtitle: { text: getSubtitle(this._currentIndex) } }, false, false, false);
                    this._chart.series[0]?.update({
                        name: String(getLabel(this._currentIndex)),
                        data: getData(this._currentIndex)
                    }, true, { duration: 500 });
                } catch { }
            }

            const chart = this._chart;

            const pause = (button) => {
                try {
                    button.title = 'play';
                    button.innerText = '▶';
                    button.style.fontSize = '18px';
                    if (chart && chart.sequenceTimer) {
                        clearInterval(chart.sequenceTimer);
                        chart.sequenceTimer = undefined;
                    }
                } catch { }
            };

            const atLastFrame = () => this._currentIndex >= (this._timeline.length - 1);

            const doUpdate = (increment) => {
                // If the chart is gone (teardown race), stop.
                if (!this._chart || this._chart.destroyed) return;

                if (increment) {
                    const next = parseInt(input.value, 10) + increment;
                    input.value = String(next);
                }

                let idx = parseInt(input.value, 10);
                if (!Number.isFinite(idx)) idx = 0;

                // clamp
                const maxI = this._timeline.length - 1;
                if (idx < 0) idx = 0;
                if (idx > maxI) idx = maxI;
                input.value = String(idx);

                // reached end? pause so we don't hammer the same frame
                if (idx >= maxI) pause(btn);

                // apply
                try {
                    const label = getLabel(idx);
                    this._chart.update({ subtitle: { text: getSubtitle(idx) } }, false, false, false);
                    const s = this._chart.series && this._chart.series[0];
                    if (s) {
                        s.update({ name: String(label), data: getData(idx) }, true, { duration: 500 });
                    }
                    this._currentIndex = idx;
                } catch {
                    // If Highcharts throws inside a teardown/update race, stop autoplay to be safe.
                    pause(btn);
                }
            };

            const play = (button) => {
                button.title = 'pause';
                button.innerText = '⏸';
                button.style.fontSize = '22px';
                if (chart.sequenceTimer) clearInterval(chart.sequenceTimer);
                // If we are already at the last frame, restart from 0 for autoplay
                if (atLastFrame()) {
                    this._currentIndex = 0;
                    input.value = '0';
                    doUpdate(0);
                }
                chart.sequenceTimer = setInterval(() => doUpdate(1), 500);
            };

            // wire controls
            if (this._onPlayPause) btn.removeEventListener('click', this._onPlayPause);
            this._onPlayPause = () => { (chart.sequenceTimer ? pause : play)(btn); };
            btn.addEventListener('click', this._onPlayPause);

            if (this._onSliderInput) input.removeEventListener('input', this._onSliderInput);
            this._onSliderInput = () => doUpdate(0);
            input.addEventListener('input', this._onSliderInput);

            if (this._onSliderChange) input.removeEventListener('change', this._onSliderChange);
            this._onSliderChange = () => doUpdate(0);
            input.addEventListener('change', this._onSliderChange);

            if (this._onSliderDown) input.removeEventListener('pointerdown', this._onSliderDown);
            this._onSliderDown = () => {
                if (chart.sequenceTimer) pause(btn);
                this._dragging = true;
            };
            input.addEventListener('pointerdown', this._onSliderDown);

            if (this._onSliderMove) input.removeEventListener('pointermove', this._onSliderMove);
            this._onSliderMove = () => {
                if (!this._dragging) return;
                doUpdate(0);
            };
            input.addEventListener('pointermove', this._onSliderMove);

            if (this._onSliderUp) input.removeEventListener('pointerup', this._onSliderUp);
            this._onSliderUp = () => { this._dragging = false; };
            input.addEventListener('pointerup', this._onSliderUp);

            if (this._onSliderCancel) input.removeEventListener('pointercancel', this._onSliderCancel);
            this._onSliderCancel = () => { this._dragging = false; };
            input.addEventListener('pointercancel', this._onSliderCancel);

            input.style.touchAction = 'none';
        }

        _teardownChart() {
            if (this._isDestroying) return;
            this._isDestroying = true;

            const btn = this.shadowRoot.getElementById('play-pause-button');
            const input = this.shadowRoot.getElementById('play-range');

            try {
                if (this._chart && this._chart.sequenceTimer) {
                    clearInterval(this._chart.sequenceTimer);
                    this._chart.sequenceTimer = undefined;
                }
            } catch { }

            try { Highcharts.stop && Highcharts.stop(this._chart); } catch { }

            if (btn && this._onPlayPause) btn.removeEventListener('click', this._onPlayPause);
            if (input && this._onSliderInput) input.removeEventListener('input', this._onSliderInput);
            if (input && this._onSliderChange) input.removeEventListener('change', this._onSliderChange);
            if (input && this._onSliderDown) input.removeEventListener('pointerdown', this._onSliderDown);
            if (input && this._onSliderMove) input.removeEventListener('pointermove', this._onSliderMove);
            if (input && this._onSliderUp) input.removeEventListener('pointerup', this._onSliderUp);
            if (input && this._onSliderCancel) input.removeEventListener('pointercancel', this._onSliderCancel);

            try {
                if (this._chart) {
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
