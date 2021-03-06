﻿import observable = require("data/observable");
import definition = require("ui/core/bindable");
import dependencyObservable = require("ui/core/dependency-observable");
import weakEventListener = require("ui/core/weak-event-listener");
import types = require("utils/types");
import trace = require("trace");
import polymerExpressions = require("js-libs/polymer-expressions");

var expressionSymbolsRegex = /[ \+\-\*%\?:<>=!\|&\(\)\[\]]/;

var bindingContextProperty = new dependencyObservable.Property(
    "bindingContext",
    "Bindable",
    new dependencyObservable.PropertyMetadata(undefined, dependencyObservable.PropertyMetadataSettings.Inheritable) // TODO: Metadata options?
    );

export class Bindable extends dependencyObservable.DependencyObservable implements definition.Bindable {

    public static bindingContextProperty = bindingContextProperty;

    // TODO: Implement with WeakRef to prevent memory leaks.
    private _bindings = {};

    get bindingContext(): Object {
        return this._getValue(Bindable.bindingContextProperty);
    }
    set bindingContext(value: Object) {
        this._setValue(Bindable.bindingContextProperty, value);
    }

    public bind(options: definition.BindingOptions, source?: Object) {
        var binding: Binding = this._bindings[options.targetProperty];
        if (binding) {
            binding.unbind();
        }

        binding = new Binding(this, options);
        this._bindings[options.targetProperty] = binding;

        var bindingSource = source;
        if (!bindingSource) {
            bindingSource = this.bindingContext;
        }
        if (bindingSource) {
            binding.bind(bindingSource);
        }
    }

    public unbind(property: string) {
        var binding: Binding = this._bindings[property];
        if (binding) {
            binding.unbind();
            delete this._bindings[property];
        }
    }

    public _updateTwoWayBinding(propertyName: string, value: any) {
        var binding: Binding = this._bindings[propertyName];

        if (binding) {
            binding.updateTwoWay(value);
        }
    }

    public _setCore(data: observable.PropertyChangeData) {
        super._setCore(data);
        this._updateTwoWayBinding(data.propertyName, data.value);
    }

    public _onPropertyChanged(property: dependencyObservable.Property, oldValue: any, newValue: any) {
        trace.write("Bindable._onPropertyChanged(" + this + ") " + property.name, trace.categories.Binding);
        super._onPropertyChanged(property, oldValue, newValue);

        if (property === Bindable.bindingContextProperty) {
            this._onBindingContextChanged(oldValue, newValue);
        }

        var binding = this._bindings[property.name];
        if (binding) {
            // we should remove (unbind and delete) binding if binding is oneWay and update is not triggered
            // by binding itself. 
            var shouldRemoveBinding = !binding.updating && !binding.options.twoWay;
            if (shouldRemoveBinding) {
                trace.write("_onPropertyChanged(" + this + ") removing binding for property: " + property.name, trace.categories.Binding);
                this.unbind(property.name);
            }
            else {
                trace.write("_updateTwoWayBinding(" + this + "): " + property.name, trace.categories.Binding);
                this._updateTwoWayBinding(property.name, newValue);
            }
        }
    }

    public _onBindingContextChanged(oldValue: any, newValue: any) {
        var binding: Binding;
        for (var p in this._bindings) {
            binding = this._bindings[p];

            if (binding.options.targetProperty === Bindable.bindingContextProperty.name && binding.updating) {
                // Updating binding context trough binding should not rebind the binding context.
                continue;
            }

            if (binding.source && binding.source.get() !== oldValue) {
                // Binding has its source set directly, not through binding context, do not bind/unbind in this case
                continue;
            }

            trace.write(
                "Binding target: " + binding.target.get() + 
                " targetProperty: " + binding.options.targetProperty +
                " to the changed context: " + newValue, trace.categories.Binding);
            binding.unbind();
            if (newValue) {
                binding.bind(newValue);
            }
        }
    }

    private static extractPropertyNameFromExpression(expression: string): string {
        var firstExpressionSymbolIndex = expression.search(expressionSymbolsRegex);
        if (firstExpressionSymbolIndex > -1) {
            return expression.substr(0, firstExpressionSymbolIndex).trim();
        }
        else {
            return expression;
        }
    }

    public static _getBindingOptions(name: string, bindingExpression: string): definition.BindingOptions {
        var result: definition.BindingOptions;
        result = {
            targetProperty: name,
            sourceProperty: ""
        };
        if (types.isString(bindingExpression)) {
            var params = bindingExpression.split(",");
            if (params.length === 1) {
                result.sourceProperty = Bindable.extractPropertyNameFromExpression(params[0].trim());
                result.expression = params[0].search(expressionSymbolsRegex) > -1 ? params[0].trim() : null;
                result.twoWay = true;
            }
            else {
                result.sourceProperty = Bindable.extractPropertyNameFromExpression(params[0].trim());
                result.expression = params[1].trim();
                result.twoWay = params[2] ? params[2].toLowerCase().trim() === "true" : true;
            }
        }
        return result;
    }
}

export class Binding {
    options: definition.BindingOptions;
    updating = false;
    source: WeakRef<Object>;
    target: WeakRef<Bindable>;
    weakEventListenerOptions: weakEventListener.WeakEventListenerOptions;

    weakEL = weakEventListener.WeakEventListener;

    private sourceOptions: { instance: WeakRef<any>; property: any };
    private targetOptions: { instance: WeakRef<any>; property: any };

    constructor(target: Bindable, options: definition.BindingOptions) {
        this.target = new WeakRef(target);
        this.options = options;
    }

    public bind(obj: Object) {
        if (!obj) {
            throw new Error("Expected valid object reference as a source in the Binding.bind method.");
        }

        /* tslint:disable */
        if (typeof (obj) === "number") {
            obj = new Number(obj);
        }
        
        if (typeof (obj) === "boolean") {
            obj = new Boolean(obj);
        }
        
        if (typeof (obj) === "string") {
            obj = new String(obj);
        }
        /* tslint:enable */
                
        this.source = new WeakRef(obj);
        this.updateTarget(this.getSourceProperty());

        if (!this.sourceOptions) {
            this.sourceOptions = this.resolveOptions(this.source, this.options.sourceProperty);
        }

        var sourceOptionsInstance = this.sourceOptions.instance.get();
        if (sourceOptionsInstance instanceof observable.Observable) {
            this.weakEventListenerOptions = {
                targetWeakRef: this.target,
                sourceWeakRef: this.sourceOptions.instance,
                eventName: observable.knownEvents.propertyChange,
                handler: this.onSourcePropertyChanged,
                handlerContext: this,
                key: this.options.targetProperty
            }
            this.weakEL.addWeakEventListener(this.weakEventListenerOptions);
        }
    }

    public unbind() {
        if (!this.source) {
            return;
        }

        this.weakEL.removeWeakEventListener(this.weakEventListenerOptions);
        this.weakEventListenerOptions = undefined;
        this.source.clear();
        this.sourceOptions.instance.clear();
        this.sourceOptions = undefined;
        this.targetOptions = undefined;
    }

    public updateTwoWay(value: any) {
        if (this.options.twoWay) {
            if (this._isExpression(this.options.expression)) {
                var changedModel = {};
                changedModel[this.options.sourceProperty] = value;
                var expressionValue = this._getExpressionValue(this.options.expression, true, changedModel);
                if (expressionValue instanceof Error) {
                    trace.write((<Error>expressionValue).message, trace.categories.Binding, trace.messageType.error);
                }
                else {
                    this.updateSource(expressionValue);
                }
            }
            else {
                this.updateSource(value);
            }
        }
    }

    private _isExpression(expression: string): boolean {
        if (expression) {
            var result = expression.indexOf(" ") !== -1;
            return result;
        }
        else {
            return false;
        }
    }

    private _getExpressionValue(expression: string, isBackConvert: boolean, changedModel: any): any {
        try {
            var exp = polymerExpressions.PolymerExpressions.getExpression(expression);
            if (exp) {
                var context = this.source && this.source.get && this.source.get() || global;
                return exp.getValue(context, isBackConvert, changedModel);
            }
            return new Error(expression + " is not a valid expression.");
        }
        catch (e) {
            var errorMessage = "Run-time error occured in file: " + e.sourceURL + " at line: " + e.line + " and column: " + e.column; 
            return new Error(errorMessage);
        }
    }

    public onSourcePropertyChanged(data: observable.PropertyChangeData) {
        if (this._isExpression(this.options.expression)) {
            var expressionValue = this._getExpressionValue(this.options.expression, false, undefined);
            if (expressionValue instanceof Error) {
                trace.write((<Error>expressionValue).message, trace.categories.Binding, trace.messageType.error);
            }
            else {
                this.updateTarget(expressionValue);
            }
        } else if (data.propertyName === this.options.sourceProperty) {
            this.updateTarget(data.value);
        }
    }

    private getSourceProperty() {
        if (this._isExpression(this.options.expression)) {
            var expressionValue = this._getExpressionValue(this.options.expression, false, undefined);
            if (expressionValue instanceof Error) {
                trace.write((<Error>expressionValue).message, trace.categories.Binding, trace.messageType.error);
            }
            else {
                return expressionValue;
            }
        }

        if (!this.sourceOptions) {
            this.sourceOptions = this.resolveOptions(this.source, this.options.sourceProperty);
        }

        var value;

        var sourceOptionsInstance = this.sourceOptions.instance.get();
        if (sourceOptionsInstance instanceof observable.Observable) {
            value = sourceOptionsInstance.get(this.sourceOptions.property);
        } else if (sourceOptionsInstance && this.sourceOptions.property &&
            this.sourceOptions.property in sourceOptionsInstance) {
            value = sourceOptionsInstance[this.sourceOptions.property];
        }
        return value;
    }

    private updateTarget(value: any) {
        if (this.updating || (!this.target || !this.target.get())) {
            return;
        }

        if (!this.targetOptions) {
            this.targetOptions = this.resolveOptions(this.target, this.options.targetProperty);
        }

        this.updateOptions(this.targetOptions, value);
    }

    private updateSource(value: any) {
        if (this.updating || (!this.source || !this.source.get())) {
            return;
        }

        if (!this.sourceOptions) {
            this.sourceOptions = this.resolveOptions(this.source, this.options.sourceProperty);
        }

        this.updateOptions(this.sourceOptions, value);
    }

    private resolveOptions(obj: WeakRef<any>, property: string): { instance: any; property: any } {
        var options;

        if (!this._isExpression(property) && types.isString(property) && property.indexOf(".") !== -1) {
            var properties = property.split(".");

            var i: number;
            var currentObject = obj.get();

            for (i = 0; i < properties.length - 1; i++) {
                currentObject = currentObject[properties[i]];
            }

            options = {
                instance: new WeakRef(currentObject),
                property: properties[properties.length - 1]
            }

        } else {
            options = {
                instance: obj,
                property: property
            }
        }

        return options;
    }

    private updateOptions(options: { instance: WeakRef<any>; property: any }, value: any) {
        this.updating = true;
        var optionsInstance = options.instance.get();

        try {
            if (optionsInstance instanceof observable.Observable) {
                optionsInstance.set(options.property, value);
            } else {
                optionsInstance[options.property] = value;
            }
        }
        catch (ex) {
            trace.write("Binding error while setting property " + options.property + " of " + optionsInstance + ": " + ex,
                trace.categories.Binding,
                trace.messageType.error);
        }

        this.updating = false;
    }
}
