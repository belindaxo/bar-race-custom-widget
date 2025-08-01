import * as Highcharts from 'highcharts';

(function () {
    class BarRace extends HTMLElement {
        constructor() {
            super();
            this.attachShadow({ mode: 'open' });

            this.shadowRoot.innerHTML = `
                <div id="parent-container">
                    <div id="play-controls">
                        <button id="play-pause-button" title="play" style="margin-left: 10px; width: 45px; height: 45px; cursor: pointer; border: 1px solid #004b8d;
                        border-radius: 25px; color: white; background-color: #004b8d; transition: background-color 250ms; font-size: 18px;">▶</button>
                        <input id="play-range" type="range" value="1960" min="1960" max="2022" style="transform: translateY(2.5px); width: calc(100% - 90px);  
                        background: #f8f8f8;"/>
                    </div>
                    <div id="container"></div>
                </div>
            `;
        }

        /**
         * Called when the widget is resized.
         * @param {number} width - New width of the widget.
         * @param {number} height - New height of the widget.
         */
        onCustomWidgetResize(width, height) {
            this._renderChart();
        }

        /**
         * Called after widget properties are updated.
         * @param {Object} changedProperties - Object containing changed attributes.
         */
        onCustomWidgetAfterUpdate(changedProperties) {
            this._renderChart();
        }

        /**
         * Called when the widget is destroyed. Cleans up chart instance.
         */
        onCustomWidgetDestroy() {
            if (this._chart) {
                this._chart.destroy();
                this._chart = null;
            }
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
                this._renderChart();
            }
        }

        async _renderChart() {
            const startYear = 1960,
                endYear = 2022,
                btn = this.shadowRoot.getElementById('play-pause-button'),
                input = this.shadowRoot.getElementById('play-range'),
                nbr = 20;

            let dataset;

            dataset = await fetch(
                'https://demo-live-data.highcharts.com/population.json'
            ).then(response => response.json());
            
            
            /*
             * Animate dataLabels functionality
             */
            (function (H) {
                const FLOAT = /^-?\d+\.?\d*$/;

                // Add animated textSetter, just like fill/strokeSetters
                H.Fx.prototype.textSetter = function () {
                    const chart = H.charts[this.elem.renderer.chartIndex];

                    let thousandsSep = chart.numberFormatter('1000.0')[1];

                    if (/[0-9]/.test(thousandsSep)) {
                        thousandsSep = ' ';
                    }

                    const replaceRegEx = new RegExp(thousandsSep, 'g');

                    let startValue = this.start.replace(replaceRegEx, ''),
                        endValue = this.end.replace(replaceRegEx, ''),
                        currentValue = this.end.replace(replaceRegEx, '');

                    if ((startValue || '').match(FLOAT)) {
                        startValue = parseInt(startValue, 10);
                        endValue = parseInt(endValue, 10);

                        // No support for float
                        currentValue = chart.numberFormatter(
                            Math.round(startValue + (endValue - startValue) * this.pos),
                            0
                        );
                    }

                    this.elem.endText = this.end;

                    this.elem.attr(this.prop, currentValue, null, true);
                };

                // Add textGetter, not supported at all at this moment:
                H.SVGElement.prototype.textGetter = function () {
                    const ct = this.text.element.textContent || '';
                    return this.endText ? this.endText : ct.substring(0, ct.length / 2);
                };

                // Temporary change label.attr() with label.animate():
                // In core it's simple change attr(...) => animate(...) for text prop
                H.wrap(H.Series.prototype, 'drawDataLabels', function (proceed) {
                    const attr = H.SVGElement.prototype.attr,
                        chart = this.chart;

                    if (chart.sequenceTimer) {
                        this.points.forEach(point =>
                            (point.dataLabels || []).forEach(
                                label =>
                                (label.attr = function (hash) {
                                    if (
                                        hash &&
                                        hash.text !== undefined &&
                                        chart.isResizing === 0
                                    ) {
                                        const text = hash.text;

                                        delete hash.text;

                                        return this
                                            .attr(hash)
                                            .animate({ text });
                                    }
                                    return attr.apply(this, arguments);

                                })
                            )
                        );
                    }

                    const ret = proceed.apply(
                        this,
                        Array.prototype.slice.call(arguments, 1)
                    );

                    this.points.forEach(p =>
                        (p.dataLabels || []).forEach(d => (d.attr = attr))
                    );

                    return ret;
                });
            }(Highcharts));


            function getData(year) {
                const output = Object.entries(dataset)
                    .map(country => {
                        const [countryName, countryData] = country;
                        return [countryName, Number(countryData[year])];
                    })
                    .sort((a, b) => b[1] - a[1]);
                return [output[0], output.slice(1, nbr)];
            }

            function getSubtitle(year) {
                const population = (getData(year)[0][1] / 1000000000).toFixed(2);
                return `
                    <span style="font-size: 80px">${year}</span>
                    <br>
                    <span style="font-size: 22px">
                    Total: <b>: ${population}</b> billion
                    </span>
                `;
            }

            const chartOptions = {
                chart: {
                    animation: {
                        duration: 500
                    },
                    marginRight: 50
                },
                title: {
                    text: 'World population by country',
                    align: 'left'
                },
                subtitle: {
                    text: getSubtitle(startYear),
                    floating: true,
                    align: 'right',
                    verticalAlign: 'middle',
                    useHTML: true,
                    y: 50,
                    x: -100
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
                        name: startYear,
                        data: getData(startYear)[1]
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

            // if (this._chart) {
            //     this._chart.destroy();
            // }
            this._chart = Highcharts.chart(this.shadowRoot.getElementById('container'), chartOptions);
            const chart = this._chart;

            /*
             * Pause the timeline, either when the range is ended, or when clicking the
             * pause button. Pausing stops the timer and resets the button to play mode.
             */
            function pause(button) {
                button.title = 'play';
                button.innerText = '▶';
                button.style.fontSize = '18px';
                clearTimeout(chart.sequenceTimer);
                chart.sequenceTimer = undefined;
            }

            /*
             * Update the chart. This happens either on updating (moving) the range input,
             * or from a timer when the timeline is playing.
             */
            function update(increment) {
                if (increment) {
                    input.value = parseInt(input.value, 10) + increment;
                }
                if (input.value >= endYear) {
                    // Auto-pause
                    pause(btn);
                }

                const year = parseInt(input.value, 10);

                chart.update(
                    {
                        subtitle: {
                            text: getSubtitle(year)
                        }
                    },
                    false,
                    false,
                    false
                );

                chart.series[0].update({
                    name: year,
                    data: getData(year)[1]
                });
            }

            /*
             * Play the timeline.
             */
            function play(button) {
                button.title = 'pause';
                button.innerText = '⏸';
                button.style.fontSize = '22px';
                chart.sequenceTimer = setInterval(function () {
                    update(1);
                }, 500);
            }

            btn.addEventListener('click', function () {
                if (chart.sequenceTimer) {
                    pause(this);
                } else {
                    play(this);
                }
            });
            /*
             * Trigger the update on the range bar click.
             */
            input.addEventListener('click', function () {
                update();
            });
        }
    }
    customElements.define('com-sap-sample-bar-race', BarRace);
})();