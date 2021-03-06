# Serverless Go Build Extended (For Compatibility with Serverless Offline)

Forked from [Sean Keenan](https://github.com/sean9keenan)'s super helpful [serverless-go-build](https://github.com/sean9keenan/serverless-go-build) repository.

This version of the repository has an additional configuration option, `useBinPathForHandler`.

```
custom:
  go-build:
    useBinPathForHandler: true
functions:
  getWidget:
    handler: bin/entrypoints/widget/main
    events:
      - http:
          path: widget
          method: get
```

When `useBinPathForHandler` is set to `true`, the plugin will assume that the path set in your functions section of the `serverless.yml` file refers to the resulting build location, and *not* the source Go file.

If you set your handler to `bin/hello/main`, it will assume that the source Go file is at `hello/main.go`.

You can set `binPath` to a custom folder name. However, you must also make sure to use that folder name in the handler name if used in conjunction with `useBinPathForHandler`.

```
custom:
  go-build:
    useBinPathForHandler: true
    binPath: compiled
functions:
  getWidget:
    handler: compiled/entrypoints/widget/main
    events:
      - http:
          path: widget
          method: get
```

The above will look for a Go file at `entrypoints/widget/main.go`, and then compile it to `compiled/entrypoints/widget/main`.

## But why though?

Other plugins such as `serverless-offline` require that the handler of a function point at the actual binary that needs to be run. The default configuration of `serverless-go-build` requires you to write the source Go file as the function handler. The use of the new `useBinPathForHandler` option allows the handler to be set to point at the compiled file as usual, making it possible to use plugins such as `serverless-offline`. 

