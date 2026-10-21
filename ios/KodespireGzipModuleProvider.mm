#import "KodespireGzipModuleProvider.h"

#import "KodespireGzipModule.h"

@implementation KodespireGzipModuleProvider

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::KodespireGzipModule>(params.jsInvoker);
}

@end
