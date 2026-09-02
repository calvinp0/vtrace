// Fixture — café 日本語 before declarations
#import <Foundation/Foundation.h>

/// A greeter.
@interface Greeter : NSObject
- (NSString *)helloWithName:(NSString *)name;
@end

@implementation Greeter
- (NSString *)helloWithName:(NSString *)name {
    return [NSString stringWithFormat:@"hi %@", name];
}
+ (instancetype)build {
    return [[self alloc] init];
}
@end

@protocol Shape
- (double)area;
@end

int add(int a, int b) { return a + b; }
