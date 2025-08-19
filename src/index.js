import * as Highcharts from 'highcharts';
import { parseMetadata } from './data/metadataParser';
import { processSeriesData } from './data/dataProcessor';
import { applyHighchartsDefaults } from './config/highchartsSetup';
import { createChartStylesheet } from './config/styles';

// Install the data label text animation shim
if (!Highcharts._barRaceLabelShimInstalled) {
    (function (H) {
        const FLOAT = /^-?\d+\.?\d*$/;

        H.Fx.prototype.textSetter = function () {
            const chart = H.charts[this.elem.renderer.chartIndex];

            let thousandsSep = chart.numberFormatter('1000.0')[1];
            if (/[0-9]/.test(thousandsSep)) {
                thousandsSep = chart.numberFormatter('1000.0', 0)[1];
            }

            const decimalPoint = chart.numberFormatter('1.0')[1];
            const startStr = String(this.start);
            const endStr = String(this.end);

            if (!FLOAT.test(startStr) || !FLOAT.test(endStr)) {
                this.elem.endText = this.end;
                this.elem.attr(this.prop, startStr);
                return;
            }

            const start = startStr
                .split(thousandsSep)
                .join('')
                .split(decimalPoint)
                .join('.');

            const end = endStr
                .split(thousandsSep)
                .join('')
                .split(decimalPoint)
                .join('.');

            const match = /^(-?\d+)(?:\.(\d+))?$/.exec(end);
            const toFixed = match ? (match[2] ? match[2].length : 0) : 0;
            this.endText = endStr;

            const text = (+start + this.pos * (end - start)).toFixed(toFixed)
                .split('.')
                .join(decimalPoint)
                .replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSep);

            this.elem.attr(this.prop, text);
        };

        H.SVGElement.prototype.textGetter = function () {
            const ct = this.text.element.textContent || '';
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

// Patch Highcharts internals for safer teardown/resizing
(function (H) {
    const { wrap } = H;

    // Guard pointer.reset
    if (H.Pointer && H.Pointer.prototype && !H.Pointer.prototype._resetWrapped) {
        wrap(H.Pointer.prototype, 'reset', function (proceed) {
            try { return proceed.apply(this, [].slice.call(arguments, 1)); }
            catch { /* no-op */ }
        });
        H.Pointer.prototype._resetWrapped = true;
    }

    // Avoid exceptions in runPointActions when chart elements are gone
    if (H.Pointer && H.Pointer.prototype && !H.Pointer.prototype._runPointActionsWrapped) {
        wrap(H.Pointer.prototype, 'runPointActions', function (proceed) {
            if (!this.chart || this.chart.destroyed) return;
            try { return proceed.apply(this, [].slice.call(arguments, 1)); }
            catch { /* no-op */ }
        });
        H.Pointer.prototype._runPointActionsWrapped = true;
    }

    // Wrap destroy methods to be idempotent
    function safeDestroyWrap(proto, key) {
        if (!proto || proto[`_${key}Wrapped`]) return;
        wrap(proto, key, function (proceed) {
            try { return proceed.apply(this, [].slice.call(arguments, 1)); } catch { /* no-op */ }
        });
        proto[`_${key}Wrapped`] = true;
    }

    // Idempotent destroy for main types
    if (H.Chart) safeDestroyWrap(H.Chart.prototype, 'destroy');
    if (H.Series) safeDestroyWrap(H.Series.prototype, 'destroy');
    if (H.Axis) safeDestroyWrap(H.Axis.prototype, 'destroy');
    if (H.Point) safeDestroyWrap(H.Point.prototype, 'destroy');

    // Null-safe erase
    const origErase = H.erase;
    H.erase = function (arr, item) {
        if (!arr || typeof arr.length !== 'number') return;
        const i = (H.inArray ? H.inArray(item, arr) : arr.indexOf(item));
        if (i > -1) arr.splice(i, 1);
    };

    // Guard destroyElements on Tooltip
    if (H.Tooltip && H.Tooltip.prototype && !H.Tooltip.prototype._destroyElementsWrapped) {
        wrap(H.Tooltip.prototype, 'destroy', function (proceed) {
            try { return proceed.apply(this, [].slice.call(arguments, 1)); } catch { /* no-op */ }
        });
        H.Tooltip.prototype._destroyElementsWrapped = true;
    }
})(Highcharts);

(function () {
    applyHighchartsDefaults(Highcharts);

    class BarRace extends HTMLElement {
        static get observedAttributes() {
            return [
                'data',
                'metadata',
                'height',
                'width',
                'title',
                'subtitle',
                'unit',
                'animate'
            ];
        }

        constructor() {
            super();

            this._chart = null;
            this._raf = 0;
            this._pendingIndex = null;
            this._currentIndex = 0;
            this._isDestroying = false;

            const shadow = this.attachShadow({ mode: 'open' });
            shadow.appendChild(createChartStylesheet());

            const wrapper = document.createElement('div');
            wrapper.className = 'wrp';

            const control = document.createElement('div');
            control.className = 'control';

            const playPauseBtn = document.createElement('button');
            playPauseBtn.id = 'play-pause-button';
            playPauseBtn.title = 'play';
            playPauseBtn.innerText = '▶';

            const range = document.createElement('input');
            range.id = 'play-range';
            range.type = 'range';
            range.min = '0';
            range.max = '1';
            range.step = '1';
            range.value = '0';

            control.appendChild(playPauseBtn);
            control.appendChild(range);

            const container = document.createElement('div');
            container.id = 'container';
            container.className = 'chart';

            wrapper.appendChild(control);
            wrapper.appendChild(container);
            shadow.appendChild(wrapper);
        }

        connectedCallback() {
            this._renderChart();
        }

        disconnectedCallback() {
            this._teardownChart();
        }

        attributeChangedCallback(name, oldValue, newValue) {
            if (oldValue === newValue) return;

            switch (name) {
                case 'data':
                case 'metadata':
                case 'height':
                case 'width':
                case 'title':
                case 'subtitle':
                case 'unit':
                case 'animate':
                    this._renderChart();
                    break;
            }
        }

        set data(val) {
            if (val == null) {
                this.removeAttribute('data');
            } else {
                this.setAttribute('data', JSON.stringify(val));
            }
        }

        get data() {
            const raw = this.getAttribute('data');
            try { return raw ? JSON.parse(raw) : null; } catch { return null; }
        }

        set metadata(val) {
            if (val == null) {
                this.removeAttribute('metadata');
            } else {
                this.setAttribute('metadata', JSON.stringify(val));
            }
        }

        get metadata() {
            const raw = this.getAttribute('metadata');
            try { return raw ? JSON.parse(raw) : null; } catch { return null; }
        }

        _parseNumericAttr(name, defVal) {
            const v = this.getAttribute(name);
            const n = Number(v);
            return Number.isFinite(n) ? n : defVal;
        }

        _renderChart() {
            const containerEl = this.shadowRoot.getElementById('container');
            if (!containerEl) return;

            // Resize container
            const h = this._parseNumericAttr('height', 500);
            containerEl.style.height = `${h}px`;

            const metadata = this.metadata;
            const data = this.data;

            if (!metadata || !data || !Array.isArray(data) || !data.length) {
                this._teardownChart();
                return;
            }

            const { dimensions, measures } = parseMetadata(metadata);
            if (!dimensions?.length || !measures?.length) {
                this._teardownChart();
                return;
            }

            // ---- New: use timeline/index-based navigation from processed data ----
            const { timeline, seriesByTime } = processSeriesData(data, dimensions, measures);
            if (!timeline.length) {
                this._teardownChart();
                return;
            }

            const btn = this.shadowRoot.getElementById('play-pause-button');
            const input = this.shadowRoot.getElementById('play-range');

            const maxIndex = timeline.length - 1;
            if (input.min !== '0') input.min = '0';
            const maxStr = String(maxIndex);
            if (input.max !== maxStr) input.max = maxStr;
            input.step = '1';

            const prevIdx = Number(input.value);
            if (Number.isFinite(prevIdx)) {
                this._currentIndex = Math.max(0, Math.min(maxIndex, prevIdx));
                input.value = String(this._currentIndex);
            } else {
                this._currentIndex = 0;
                input.value = '0';
            }

            const currentLabel = () => timeline[this._currentIndex];

            const nbr = 10;
            const getData = (idx) => {
                const label = timeline[idx];
                const timeData = seriesByTime?.[label] || {};
                return Object.entries(timeData)
                    .map(([category, value]) => [category, Number(value) || 0])
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, nbr);
            };

            const getSubtitle = (idx) => {
                const label = timeline[idx];
                const sum = Object.values(seriesByTime[label] || {})
                    .reduce((s, v) => s + (Number(v) || 0), 0);
                const total = Highcharts.numberFormat(sum, 0, '.', ',');
                return `
  <span style="font-size: 80px">${label}</span>
  <br>
  <span style="font-size: 22px">
      Total: <b>${total}</b>
  </span>
  `;
            };

            // Teardown any existing chart safely
            this._teardownChart();

            // Build chart
            this._chart = Highcharts.chart(containerEl, {
                chart: {
                    animation: { duration: 500 },
                    marginRight: 50,
                    events: {
                        load: function () {
                            this.isResizing = 0;
                        },
                        render: function () {
                            // keep a small sentinel for resize busy state
                            if (this.isResizing > 0) this.isResizing--;
                        }
                    }
                },
                title: {
                    text: this.getAttribute('title') || 'Chart Title',
                    align: 'left'
                },
                subtitle: {
                    text: getSubtitle(this._currentIndex),
                    floating: true,
                    align: 'right',
                    verticalAlign: 'middle',
                    useHTML: true,
                    y: 100,
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
                        dataSorting: {
                            enabled: true,
                            matchByName: true
                        },
                        type: 'bar',
                        dataLabels: { enabled: true }
                    }
                },
                series: [{
                    type: 'bar',
                    name: String(currentLabel()),
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
                                    dataLabels: [
                                        { enabled: true, y: 8 },
                                        {
                                            enabled: true,
                                            format: '{point.name}',
                                            y: -8,
                                            style: { fontWeight: 'normal', opacity: 0.7 }
                                        }
                                    ]
                                }
                            }
                        }
                    }]
                }
            });

            const chart = this._chart;

            const pause = (button) => {
                button.title = 'play';
                button.innerText = '▶';
                button.style.fontSize = '18px';
                if (chart.sequenceTimer) clearInterval(chart.sequenceTimer);
                chart.sequenceTimer = undefined;
            };

            const doUpdate = (increment) => {
                if (increment) {
                    input.value = String(Math.min(maxIndex, parseInt(input.value, 10) + increment));
                }

                let idx = parseInt(input.value, 10);
                if (!Number.isFinite(idx)) idx = 0;
                idx = Math.max(0, Math.min(maxIndex, idx));
                input.value = String(idx);

                this._pendingIndex = idx;
                if (this._raf) return;

                this._raf = requestAnimationFrame(() => {
                    this._raf = 0;
                    const targetIdx = this._pendingIndex;
                    this._pendingIndex = null;

                    if (this._isDestroying || !this._chart) return;
                    const chartNow = this._chart;

                    if (targetIdx >= maxIndex) {
                        pause(btn);
                    }

                    chartNow.update({ subtitle: { text: getSubtitle(targetIdx) } }, false, false, false);
                    chartNow.series[0].update(
                        { name: String(timeline[targetIdx]), data: getData(targetIdx) },
                        true,
                        { duration: 500 }
                    );

                    this._currentIndex = targetIdx;
                });
            };

            const play = (button) => {
                button.title = 'pause';
                button.innerText = '⏸';
                button.style.fontSize = '22px';
                if (chart.sequenceTimer) clearInterval(chart.sequenceTimer);
                chart.sequenceTimer = setInterval(() => {
                    if (parseInt(input.value, 10) >= maxIndex) {
                        pause(btn);
                        return;
                    }
                    doUpdate(1);
                }, 500);
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

            try {
                if (this._raf) cancelAnimationFrame(this._raf);
            } catch { }
            this._raf = 0;

            try {
                const btn = this.shadowRoot?.getElementById('play-pause-button');
                const input = this.shadowRoot?.getElementById('play-range');
                if (this._onPlayPause && btn) btn.removeEventListener('click', this._onPlayPause);
                if (this._onSliderInput && input) input.removeEventListener('input', this._onSliderInput);
                this._onPlayPause = null;
                this._onSliderInput = null;
            } catch { }

            try {
                if (this._chart) {
                    if (this._chart.sequenceTimer) {
                        clearInterval(this._chart.sequenceTimer);
                        this._chart.sequenceTimer = null;
                    }
                }
            } catch { }

            try {
                if (this._chart) {
                    this._chart.isResizing = 0;
                    this._chart.pointer?.reset?.(true);
                }
            } catch { }

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