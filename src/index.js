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
            this.elem.endText = this.end;
            this.elem.attr(this.prop, currentValue, null, true);
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

            // bound handlers
            this._onPlayPause = null;
            this._onSliderInput = null;
            this._onSliderChange = null;
            this._onSliderDown = null;
            this._onSliderMove = null;
            this._onSliderUp = null;
            this._onSliderCancel = null;
            this._onMouseDown = null;
            this._onMouseMove = null;
            this._onMouseUp = null;

            // flags
            this._isDestroying = false;
            this._dragging = false;

            // RAF batching
            this._raf = 0;
            this._pendingYear = null;
        }

        /**
         * Called when the widget is resized.
         * @param {number} width - New width of the widget.
         * @param {number} height - New height of the widget.
         */
        onCustomWidgetResize(width, height) {
            this._scheduleRender();
        }

        /**
         * Called after widget properties are updated.
         * @param {Object} changedProperties - Object containing changed attributes.
         */
        onCustomWidgetAfterUpdate(changedProperties) {
            this._scheduleRender();
        }

        /**
         * Called when the widget is destroyed. Cleans up chart instance.
         */
        onCustomWidgetDestroy() {
            if (this._isDestroying) return;
            this._isDestroying = true;

            // pause autoplay first
            if (this._chart && this._chart.sequenceTimer) {
                clearInterval(this._chart.sequenceTimer);
                this._chart.sequenceTimer = undefined;
            }

            // stop any running Highcharts animations
            try { Highcharts.stop && Highcharts.stop(this._chart); } catch { }

            // detach listeners
            const btn = this.shadowRoot.getElementById('play-pause-button');
            const input = this.shadowRoot.getElementById('play-range');
            if (btn && this._onPlayPause) btn.removeEventListener('click', this._onPlayPause);
            if (input && this._onSliderInput) input.removeEventListener('input', this._onSliderInput);
            if (input && this._onSliderChange) input.removeEventListener('change', this._onSliderChange);
            if (input && this._onSliderDown) input.removeEventListener('pointerdown', this._onSliderDown);
            if (input && this._onSliderMove) input.removeEventListener('pointermove', this._onSliderMove);
            if (input && this._onSliderUp) input.removeEventListener('pointerup', this._onSliderUp);
            if (input && this._onSliderCancel) input.removeEventListener('pointercancel', this._onSliderCancel);
            if (input && this._onMouseDown) input.removeEventListener('mousedown', this._onMouseDown);
            if (input && this._onMouseMove) input.removeEventListener('mousemove', this._onMouseMove);
            if (input && this._onMouseUp) input.removeEventListener('mouseup', this._onMouseUp);

            try { this._chart && this._chart.destroy(); } catch { }
            this._chart = null;
            this._isDestroying = false; // allow future renders
        }

        _scheduleRender() {
            if (this._dragging) return; // don't re-render while dragging slider
            clearTimeout(this._renderTimer);
            this._renderTimer = setTimeout(() => this._renderChart(), 0);
        }

        /**
        * Called when an observed attribute changes.
        * @param {string} name - The name of the changed attribute.
        * @param {string} oldValue - The old value of the attribute.
        * @param {string} newValue - The new value of the attribute.
        */
        attributeChangedCallback(name, oldValue, newValue) {
            if (oldValue !== newValue) {
                this[name] = newValue;
                this._scheduleRender();
            }
        }

        _renderChart() {
            const dataBinding = this.dataBinding;
            if (!dataBinding || dataBinding.state !== 'success' || !dataBinding.data || dataBinding.data.length === 0) {
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

            // Build a sorted list of years (numeric if possible)
            const labelKeys = Object.keys(structuredData);
            let years;
            const numericYears = labelKeys.map(k => Number(k));
            if (numericYears.every(Number.isFinite)) {
                years = numericYears.sort((a, b) => a - b);
            } else {
                // fallback: keep insertion order
                years = labelKeys;
            }

            if (!years.length) {
                this._teardownChart();
                return;
            }

            const startYear = years[0];
            const endYear = years[years.length - 1];
            const nbr = 10;

            const btn = this.shadowRoot.getElementById('play-pause-button');
            const input = this.shadowRoot.getElementById('play-range');

            // configure slider bounds/step once
            const minStr = String(startYear);
            const maxStr = String(endYear);
            if (input.min !== minStr) input.min = minStr;
            if (input.max !== maxStr) input.max = maxStr;
            input.step = '1';

            // preserve current year if valid, else set to start year, with clamping
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
            }

            applyHighchartsDefaults();

            if (!this._chart) {
                const chartOptions = {
                    chart: {
                        animation: {
                            duration: 500
                        },
                        marginRight: 50
                    },
                    title: {
                        text: 'Chart Title',
                        align: 'left'
                    },
                    subtitle: {
                        text: getSubtitle(this._currentYear),
                        floating: true,
                        align: 'right',
                        verticalAlign: 'middle',
                        useHTML: true,
                        y: 100,
                        x: -20
                    },
                    credits: {
                        enabled: false
                    },
                    legend: {
                        enabled: false
                    },
                    xAxis: {
                        type: 'category'
                    },
                    yAxis: {
                        opposite: true,
                        tickPixelInterval: 150,
                        title: {
                            text: null
                        }
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
                            dataLabels: {
                                enabled: true
                            }
                        }
                    },
                    series: [
                        {
                            type: 'bar',
                            name: String(this._currentYear),
                            data: getData(this._currentYear)
                        }
                    ],
                    responsive: {
                        rules: [{
                            condition: {
                                maxWidth: 550
                            },
                            chartOptions: {
                                xAxis: {
                                    visible: false
                                },
                                subtitle: {
                                    x: 0
                                },
                                plotOptions: {
                                    series: {
                                        dataLabels: [{
                                            enabled: true,
                                            y: 8
                                        }, {
                                            enabled: true,
                                            format: '{point.name}',
                                            y: -8,
                                            style: {
                                                fontWeight: 'normal',
                                                opacity: 0.7
                                            }
                                        }]
                                    }
                                }
                            }
                        }]
                    }
                };
                this._chart = Highcharts.chart(this.shadowRoot.getElementById('container'), chartOptions);
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
            }

            const doUpdate = (increment) => {
                if (increment) {
                    input.value = String(parseInt(input.value, 10) + increment);
                }

                // compute the clamped year/position once
                let yr = parseInt(input.value, 10);
                if (!Number.isFinite(yr)) yr = Number(startYear);
                yr = Math.max(Number(startYear), Math.min(Number(endYear), yr));
                input.value = String(yr);

                // store latest request and schedule exactly one draw per frame
                this._pendingYear = yr;
                if (this._raf) return;

                this._raf = requestAnimationFrame(() => {
                    this._raf = 0;
                    const year = this._pendingYear;
                    this._pendingYear = null;

                    if (year >= Number(endYear)) {
                        // stop the interval so it doesn't keep updating the same frame
                        pause(btn);
                    }

                    // update subtitle without full redraw (series.update will redraw)
                    chart.update({ subtitle: { text: getSubtitle(year) } }, false, false, false);

                    // update series (dataSorting handles the race animation)
                    chart.series[0].update({ name: String(year), data: getData(year) }, true, { duration: 500 });

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

            if (this._onPlayPause) btn.removeEventListener('click', this._onPlayPause);
            this._onPlayPause = () => {
                if (chart.sequenceTimer) pause(btn);
                else play(btn);
            };
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
                // let the native slider set value, then update chart
                doUpdate(0);
            };
            input.addEventListener('pointermove', this._onSliderMove);

            if (this._onSliderUp) input.removeEventListener('pointerup', this._onSliderUp);
            this._onSliderUp = () => { this._dragging = false; };
            input.addEventListener('pointerup', this._onSliderUp);

            if (this._onSliderCancel) input.removeEventListener('pointercancel', this._onSliderCancel);
            this._onSliderCancel = () => { this._dragging = false; };
            input.addEventListener('pointercancel', this._onSliderCancel);

            // Mouse fallback (for environments without pointer events on range)
            if (this._onMouseDown) input.removeEventListener('mousedown', this._onMouseDown);
            this._onMouseDown = () => { if (chart.sequenceTimer) pause(btn); this._dragging = true; };
            input.addEventListener('mousedown', this._onMouseDown);

            if (this._onMouseMove) input.removeEventListener('mousemove', this._onMouseMove);
            this._onMouseMove = () => { if (!this._dragging) return; doUpdate(0); };
            input.addEventListener('mousemove', this._onMouseMove);

            if (this._onMouseUp) input.removeEventListener('mouseup', this._onMouseUp);
            this._onMouseUp = () => { this._dragging = false; };
            input.addEventListener('mouseup', this._onMouseUp);


            input.style.touchAction = 'none';
        }

        _teardownChart() {
            if (this._isDestroying) return;
            this._isDestroying = true;

            const btn = this.shadowRoot.getElementById('play-pause-button');
            const input = this.shadowRoot.getElementById('play-range');

            if (this._chart && this._chart.sequenceTimer) {
                clearInterval(this._chart.sequenceTimer);
                this._chart.sequenceTimer = undefined;
            }
            try { Highcharts.stop && Highcharts.stop(this._chart); } catch { }

            if (btn && this._onPlayPause) btn.removeEventListener('click', this._onPlayPause);
            if (input && this._onSliderInput) input.removeEventListener('input', this._onSliderInput);
            if (input && this._onSliderChange) input.removeEventListener('change', this._onSliderChange);
            if (input && this._onSliderDown) input.removeEventListener('pointerdown', this._onSliderDown);
            if (input && this._onSliderMove) input.removeEventListener('pointermove', this._onSliderMove);
            if (input && this._onSliderUp) input.removeEventListener('pointerup', this._onSliderUp);
            if (input && this._onSliderCancel) input.removeEventListener('pointercancel', this._onSliderCancel);
            if (input && this._onMouseDown) input.removeEventListener('mousedown', this._onMouseDown);
            if (input && this._onMouseMove) input.removeEventListener('mousemove', this._onMouseMove);
            if (input && this._onMouseUp) input.removeEventListener('mouseup', this._onMouseUp);


            try { if (this._chart) this._chart.destroy(); } catch {}
            this._chart = null;
            this._isDestroying = false; // allow future renders
        }

    }
    customElements.define('com-sap-sample-bar-race', BarRace);
})();