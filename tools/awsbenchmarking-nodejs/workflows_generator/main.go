package main

import (
	"context"
	"flag"
	"fmt"
	"os/user"
	"path/filepath"
	"sync"
	"time"
	"strconv"

	"github.com/google/uuid"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/rest"

	wfv1 "github.com/argoproj/argo-workflows/v3/pkg/apis/workflow/v1alpha1"
	wfclientset "github.com/argoproj/argo-workflows/v3/pkg/client/clientset/versioned"
)

var helloWorldWorkflow = wfv1.Workflow{
	ObjectMeta: metav1.ObjectMeta{
		GenerateName: "hello-world-",
	},
	Spec: wfv1.WorkflowSpec{
		Entrypoint: "whalesay",
		ServiceAccountName: "argo",
		Templates: []wfv1.Template{
			{
				Name: "whalesay",
				Container: &corev1.Container{
					Image:   "240127755072.dkr.ecr.us-east-1.amazonaws.com/docker-hub/docker/whalesay:latest",
                    Command: []string{"cowsay", "hello world"},
				},
			},
		},
		PodGC: &wfv1.PodGC{
			Strategy: "OnPodSuccess",
		},
		TTLStrategy: &wfv1.TTLStrategy{
			SecondsAfterCompletion: returnNumSeconds(),
			SecondsAfterSuccess: returnNumSeconds(),
			SecondsAfterFailure: returnNumSeconds(),
		},
	},
}

func returnNumSeconds() *int32 {
	var seconds int32
	seconds = 60
	return &seconds
}

func buildConfigFromFlags(context, kubeconfigPath string) (*rest.Config, error) {
	return clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
			&clientcmd.ClientConfigLoadingRules{ExplicitPath: kubeconfigPath},
			&clientcmd.ConfigOverrides{
					CurrentContext: context,
			}).ClientConfig()
}

func main() {
	var wg sync.WaitGroup
	// get current user to determine home directory
	usr, err := user.Current()
	checkErr(err)

	// get kubeconfig file location
	kubeconfig := flag.String("kubeconfig", filepath.Join(usr.HomeDir, ".kube", "config"), "(optional) absolute path to the kubeconfig file")
	flag.Parse()

	// use the current context in kubeconfig
	config, err := buildConfigFromFlags("argotesting0", *kubeconfig)
	checkErr(err)

	config.QPS = 500
    config.Burst = 1000

	// create the workflow client
	wfClient := wfclientset.NewForConfigOrDie(config);

	numNamespaces := 1
	numVUsers := 10
	maxWorkflows := 0
	creationDelay,err := time.ParseDuration("2000ms")
	checkErr(err)

	if numVUsers > 1 {
		maxWorkflows = maxWorkflows / numVUsers
	}
	
	fmt.Printf("Namespaces: %d\n", numNamespaces)
	fmt.Printf("VUsers: %d\n", numVUsers)
	fmt.Printf("Workflows / VUser: %d\n", maxWorkflows)

	for i := 1; i <= numNamespaces; i++ {
		for j := 1; j <= numVUsers; j++ {
			wg.Add(1)
			go vUser(j, "argoworkflows"+strconv.Itoa(i), maxWorkflows, creationDelay, &wg, wfClient)
		}
    }

	wg.Wait()
}

func vUser(vUserNum int, namespace string, maxWorkflows int, creationDelay time.Duration, wg *sync.WaitGroup, clientset *wfclientset.Clientset) {
	fmt.Printf("%d %d\n", vUserNum, maxWorkflows)
	defer wg.Done()


	i := 1
	for {
		wfClient := clientset.ArgoprojV1alpha1().Workflows(namespace)
		// submit the hello world workflow
		ctx := context.Background()
		id := uuid.New()
		helloWorldWorkflow.ObjectMeta.GenerateName = "hello-world-"+id.String() + "-" + strconv.Itoa(vUserNum)
		_, err := wfClient.Create(ctx, &helloWorldWorkflow, metav1.CreateOptions{})
		checkErr(err)

		time.Sleep(creationDelay)
		i++
		if maxWorkflows != 0 {
			if i > maxWorkflows {
				break
			}
		}
	}
}

func checkErr(err error) {
	if err != nil {
		fmt.Print(err.Error())
	}
}
