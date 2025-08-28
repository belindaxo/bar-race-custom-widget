(function () {
    let template = document.createElement('template');
    template.innerHTML = `
        <form id="form">
        <legend style="font-weight: bold;font-size: 18px;"> Font </legend>
        <table>
            <tr>
                <td>Chart Title</td>
            </tr>
            <tr>
                <td><input id="chartTitle" type="text"></td>
            </tr>
            <tr>
                <table>
                    <tr>
                        <td>Size</td>
                        <td>Font Style</td>
                        <td>Alignment</td>
                        <td>Color</td>
                    </tr>
                    <tr>
                        <td>
                            <select id="titleSize">
                                <option value="10px">10</option>
                                <option value="12px">12</option>
                                <option value="14px">14</option>
                                <option value="16px" selected>16</option>
                                <option value="18px">18</option>
                                <option value="20px">20</option>
                                <option value="22px">22</option>
                                <option value="24px">24</option>
                                <option value="32px">32</option>
                                <option value="48px">48</option>
                            </select>
                        </td>
                        <td>
                            <select id="titleFontStyle">
                                <option value="normal">Normal</option>
                                <option value="bold" selected>Bold</option>
                            </select>
                        </td>
                        <td>
                            <select id="titleAlignment">
                                <option value="left" selected>Left</option>
                                <option value="center">Center</option>
                                <option value="right">Right</option>
                            </select>
                        </td>
                        <td>
                            <input id="titleColor" type="color" value="#004B8D">
                        </td>
                    </tr>
                </table>
            </tr>
        </table>
        <legend style="font-weight: bold;font-size: 18px; margin-top: 10px;"> Subtitle Properties</legend>
        <table>
            <tr>
                <td> Date Size</td>
            </tr>
            <tr>
                <td>
                    <select id="subtitleDateSize">
                        <option value="10px">10</option>
                        <option value="12px">12</option>
                        <option value="14px">14</option>
                        <option value="16px">16</option>
                        <option value="18px">18</option>
                        <option value="20px">20</option>
                        <option value="22px">22</option>
                        <option value="24px">24</option>
                        <option value="32px">32</option>
                        <option value="48px">48</option>
                        <option value="72px">72</option>
                        <option value="80px" selected>80</option>
                    </select>
                </td>
            </tr>
            <tr>
                <td> Total Size</td>
            </tr>
            <tr>
                <td>
                    <select id="subtitleTotalSize">
                        <option value="10px">10</option>
                        <option value="12px">12</option>
                        <option value="14px">14</option>
                        <option value="16px">16</option>
                        <option value="18px">18</option>
                        <option value="20px">20</option>
                        <option value="22px" selected>22</option>
                        <option value="24px">24</option>
                        <option value="32px">32</option>
                        <option value="48px">48</option>
                        <option value="72px">72</option>
                        <option value="80px">80</option>
                    </select>
                </td>
            </tr>
            <tr>
                <td> X Position</td>
                <td> Y Position</td>
            </tr>
            <tr>
                <td>
                    <input id="subtitleX" type="number" value="-20" style="width: 60px;">
                </td>
                <td>
                    <input id="subtitleY" type="number" value="100" style="width: 60px;">
                </td>
            </tr>
        </table>
        <legend style="font-weight: bold;font-size: 18px; margin-top: 10px;"> Number Formatting </legend>
        <table>
            <tr>
                <td>Scale Format</td>
            </tr>
            <tr>
                <td>
                    <select id="scaleFormat">
                        <option value="unformatted" selected>Unformatted</option>
                        <option value="k">Thousands (k)</option>
                        <option value="m">Millions (m)</option>
                        <option value="b">Billions (b)</option>
                    </select>
                </td>
            </tr>
            <tr>
                <td>Decimal Places</td>
            </tr>
            <tr>
                <td>
                    <select id="decimalPlaces">
                        <option value="0" selected>0</option>
                        <option value="1">1</option>
                        <option value="2">2</option>
                        <option value="3">3</option>
                        <option value="4">4</option>
                        <option value="5">5</option>
                    </select>
                </td>
            </tr>
        </table>
        <tr>
            <button id="resetDefaults" type="button" style="margin-top: 10px; margin-bottom: 10px;">Reset to Default</button>
        </tr>
        <input type="submit" style="display:none;">
        </form>
    `;

    class BarRaceAps extends HTMLElement {
        constructor() {
            super();

            const DEFAULTS = {
                chartTitle: '',
                titleSize: '16px',
                titleFontStyle: 'bold',
                titleAlignment: 'left',
                titleColor: '#004B8D',
                subtitleDateSize: '80px',
                subtitleTotalSize: '22px',
                subtitleX: -20,
                subtitleY: 100,
                scaleFormat: 'unformatted',
                decimalPlaces: '0'
            };

            this._shadowRoot = this.attachShadow({ mode: 'open' });
            this._shadowRoot.appendChild(template.content.cloneNode(true));

            this._shadowRoot.getElementById('form').addEventListener('submit', this._submit.bind(this));
            this._shadowRoot.getElementById('titleSize').addEventListener('change', this._submit.bind(this));
            this._shadowRoot.getElementById('titleFontStyle').addEventListener('change', this._submit.bind(this));
            this._shadowRoot.getElementById('titleAlignment').addEventListener('change', this._submit.bind(this));
            this._shadowRoot.getElementById('titleColor').addEventListener('change', this._submit.bind(this));
            this._shadowRoot.getElementById('subtitleDateSize').addEventListener('change', this._submit.bind(this));
            this._shadowRoot.getElementById('subtitleTotalSize').addEventListener('change', this._submit.bind(this));
            this._shadowRoot.getElementById('subtitleX').addEventListener('change', this._submit.bind(this));
            this._shadowRoot.getElementById('subtitleY').addEventListener('change', this._submit.bind(this));
            this._shadowRoot.getElementById('scaleFormat').addEventListener('change', this._submit.bind(this));
            this._shadowRoot.getElementById('decimalPlaces').addEventListener('change', this._submit.bind(this));

            // Reset button logic
            this._shadowRoot.getElementById('resetDefaults').addEventListener('click', () => {
                for (const key in DEFAULTS) {
                    if (key === 'chartTitle' || key === 'subtitleX' || key === 'subtitleY') {
                        continue;
                    }

                    const element = this._shadowRoot.getElementById(key);
                    if (!element) continue;

                    if (typeof DEFAULTS[key] === 'boolean') {
                        element.checked = DEFAULTS[key];
                    } else {
                        element.value = DEFAULTS[key];
                    }
                }
                this._submit(new Event('submit'));
            });
        }

        _submit(e) {
            e.preventDefault();
            this.dispatchEvent(new CustomEvent('propertiesChanged', {
                detail: {
                    properties: {
                        chartTitle: this.chartTitle,
                        titleSize: this.titleSize,
                        titleFontStyle: this.titleFontStyle,
                        titleAlignment: this.titleAlignment,
                        titleColor: this.titleColor,
                        subtitleDateSize: this.subtitleDateSize,
                        subtitleTotalSize: this.subtitleTotalSize,
                        subtitleX: this.subtitleX,
                        subtitleY: this.subtitleY,
                        scaleFormat: this.scaleFormat,
                        decimalPlaces: this.decimalPlaces
                    }
                }
            }));
        }

        // Getters and setters
        get chartTitle() {
            return this._shadowRoot.getElementById('chartTitle').value;
        }

        set chartTitle(value) {
            this._shadowRoot.getElementById('chartTitle').value = value;
        }

        get titleSize() {
            return this._shadowRoot.getElementById('titleSize').value;
        }

        set titleSize(value) {
            this._shadowRoot.getElementById('titleSize').value = value;
        }

        get titleFontStyle() {
            return this._shadowRoot.getElementById('titleFontStyle').value;
        }

        set titleFontStyle(value) {
            this._shadowRoot.getElementById('titleFontStyle').value = value;
        }

        get titleAlignment() {
            return this._shadowRoot.getElementById('titleAlignment').value;
        }

        set titleAlignment(value) {
            this._shadowRoot.getElementById('titleAlignment').value = value;
        }

        get titleColor() {
            return this._shadowRoot.getElementById('titleColor').value;
        }

        set titleColor(value) {
            this._shadowRoot.getElementById('titleColor').value = value;
        }

        get subtitleDateSize() {
            return this._shadowRoot.getElementById('subtitleDateSize').value;
        }

        set subtitleDateSize(value) {
            this._shadowRoot.getElementById('subtitleDateSize').value = value;
        }

        get subtitleTotalSize() {
            return this._shadowRoot.getElementById('subtitleTotalSize').value;
        }

        set subtitleTotalSize(value) {
            this._shadowRoot.getElementById('subtitleTotalSize').value = value;
        }

        get subtitleX() {
            return parseInt(this._shadowRoot.getElementById('subtitleX').value, 10);
        }

        set subtitleX(value) {
            this._shadowRoot.getElementById('subtitleX').value = value;
        }

        get subtitleY() {
            return parseInt(this._shadowRoot.getElementById('subtitleY').value, 10);
        }

        set subtitleY(value) {
            this._shadowRoot.getElementById('subtitleY').value = value;
        }

        get scaleFormat() {
            return this._shadowRoot.getElementById('scaleFormat').value;
        }

        set scaleFormat(value) {
            this._shadowRoot.getElementById('scaleFormat').value = value;
        }

        get decimalPlaces() {
            return this._shadowRoot.getElementById('decimalPlaces').value;
        }

        set decimalPlaces(value) {
            this._shadowRoot.getElementById('decimalPlaces').value = value;
        }
    }
    customElements.define('com-sap-sample-bar-race-aps', BarRaceAps);
})();